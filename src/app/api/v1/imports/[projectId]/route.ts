import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { existsSync } from 'fs';
import { mkdir, readdir, rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { client, db } from '@/db';
import {
  previewAttachment,
  previewEvent,
  previewMessage,
  previewSession,
  PREVIEW_SESSION_LIVE_STATUSES,
} from '@/db/schema';
import { verifyApiKey } from '@/lib/api-key';
import {
  authorFromHeaders,
  declaredTooLarge,
  receiveZip,
} from '@/lib/import-upload';
import { verifyImportToken } from '@/lib/import-token';
import { extractCredentials, sessionCorsHeaders } from '@/lib/request-credentials';
import { removeProjectSettings } from '@/lib/settings';
import { isProjectId } from '@/lib/project-id';
import { removeSessionUploads } from '@/lib/uploads';
import { archiveBackupRepo, backupState, queueBackup } from '@/worker/backup';
import { config, ensureWorkspace } from '@/worker/config';
import { hasOrigin, repoDir } from '@/worker/git';
import {
  acquireReplaceLock,
  importsRoot,
  replaceWorkspace,
} from '@/worker/replace';
import { extractZip, stripWrapperDir, ZipError } from '@/worker/zip-extract';
import { checkFramework } from '@/preview/framework';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only) management of a project's pilot state:
 *  - GET: does the workspace exist (hub's finalizeUpload verification)
 *    and its detected framework.
 *  - DELETE: tear down EVERYTHING the pilot holds for the project when the hub
 *    deletes the project — workspace clone, all preview sessions (+ their transcripts/events/attachments/staged
 *    uploads), and the per-project settings overrides. Any live editing session
 *    is auto-closed (its dev server killed by pid), so delete never 409s.
 *    Runs for GitHub and upload projects alike. An upload project's GitHub
 *    backup repo is archived, never deleted.
 *  - POST: replace an upload project's whole source with a new zip (hub
 *    "Import" inside a project). Api key or a one-time `scope:'replace'`
 *    token; the browser streams the zip here directly, like the first import.
 */

const authenticate = async (request: Request) => {
  const { apiKeyCandidate } = extractCredentials(request);
  return Boolean(await verifyApiKey(apiKeyCandidate));
};

const parseProjectId = (raw: string) => (isProjectId(raw) ? raw : null);

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const projectId = parseProjectId((await params).projectId);
  if (!projectId) {
    return Response.json({ error: 'Invalid projectId' }, { status: 400 });
  }
  const dir = repoDir(projectId);
  const exists = existsSync(join(dir, '.git'));
  let framework: string | null = null;
  if (exists) {
    // Sites live at the repo root; anything unsupported reports null.
    const check = checkFramework(dir);
    framework = check.ok ? check.framework : null;
  }
  return Response.json({
    exists,
    framework,
    backup: exists ? await backupState(dir) : null,
  });
};

export const DELETE = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const projectId = parseProjectId((await params).projectId);
  if (!projectId) {
    return Response.json({ error: 'Invalid projectId' }, { status: 400 });
  }

  // Every session for the project. Live ones get their dev server killed by pid
  // (supervisor + this Next app share the container's pid namespace), which
  // frees the port; then all rows are pruned. No 409 — delete always proceeds.
  const sessions = await db
    .select({ id: previewSession.id, pid: previewSession.pid, status: previewSession.status })
    .from(previewSession)
    .where(eq(previewSession.projectId, projectId));
  const liveStatuses = new Set<string>(PREVIEW_SESSION_LIVE_STATUSES);
  for (const session of sessions) {
    if (session.pid && liveStatuses.has(session.status)) {
      try {
        process.kill(session.pid, 'SIGTERM');
      } catch {
        // Already gone — the port frees itself.
      }
    }
    await removeSessionUploads(session.id);
  }
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length) {
    await db
      .delete(previewAttachment)
      .where(inArray(previewAttachment.sessionId, sessionIds));
    await db
      .delete(previewEvent)
      .where(inArray(previewEvent.sessionId, sessionIds));
    await db
      .delete(previewMessage)
      .where(inArray(previewMessage.sessionId, sessionIds));
    await db
      .delete(previewSession)
      .where(eq(previewSession.projectId, projectId));
  }

  // Path safety: same direct-child check as the admin workspaces delete.
  const base = resolve(config.workspaceDir);
  const target = resolve(join(base, projectId));
  if (target === base || !target.startsWith(base + sep)) {
    return Response.json({ error: 'Invalid projectId' }, { status: 400 });
  }
  if (existsSync(target)) {
    // Read the backup repo name from the clone before it's gone.
    await archiveBackupRepo(target);
    await rm(target, { recursive: true, force: true });
  }
  // Per-project setting overrides die with the project.
  await removeProjectSettings(projectId);
  try {
    await client.notify('cp_preview', '');
  } catch {
    // The supervisor also refreshes on an interval.
  }
  return Response.json({ deleted: true });
};

export const OPTIONS = async (request: Request) =>
  new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });

// Sessions still booting own the clone (npm install, checkout); replacing the
// tree under them would race. Ready/paused ones are stopped instead.
const BOOTING = new Set<string>(['starting', 'installing', 'restarting']);
const TERMINAL = ['failed', 'closed', 'published', 'expired'] as const;

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const projectId = parseProjectId((await params).projectId);
  if (!projectId) {
    return Response.json({ error: 'Invalid projectId' }, { status: 400, headers });
  }
  const { apiKeyCandidate, editTokenCandidate } = extractCredentials(request);
  const token = verifyImportToken(editTokenCandidate, 'replace');
  const authed =
    Boolean(await verifyApiKey(apiKeyCandidate)) ||
    (token !== null && token.projectId === projectId);
  if (!authed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const dir = repoDir(projectId);
  if (!existsSync(join(dir, '.git'))) {
    return Response.json(
      { error: "This project's files are missing from the preview server." },
      { status: 404, headers }
    );
  }
  if (await hasOrigin(dir)) {
    return Response.json(
      { error: 'GitHub projects update through GitHub, not an upload.' },
      { status: 400, headers }
    );
  }
  if (declaredTooLarge(request)) {
    return Response.json(
      { error: 'Zip is larger than 100 MB.' },
      { status: 413, headers }
    );
  }

  ensureWorkspace();
  const release = await acquireReplaceLock(projectId);
  if (!release) {
    return Response.json(
      { error: 'Another import is already running for this project.' },
      { status: 409, headers }
    );
  }

  const stamp = Date.now();
  const zipPath = join(importsRoot(), `${projectId}-r${stamp}.zip`);
  const staging = join(importsRoot(), `${projectId}-r${stamp}`);
  const name = (new URL(request.url).searchParams.get('name') || 'new upload').slice(0, 100);

  try {
    await mkdir(importsRoot(), { recursive: true });
    await receiveZip(request, zipPath);
    const { files } = await extractZip(zipPath, staging);
    await stripWrapperDir(staging);
    if (!files || !(await readdir(staging)).length) {
      return Response.json(
        { error: 'The zip contains no files.' },
        { status: 422, headers }
      );
    }
    // Same gate as the first import, checked BEFORE the workspace is touched:
    // a Next.js or SSR upload leaves the current site exactly as it was.
    const check = checkFramework(staging);
    if (!check.ok) {
      return Response.json(
        { error: check.message, code: 'unsupported_framework', reason: check.reason },
        { status: 422, headers }
      );
    }

    const sessions = await db
      .select({ id: previewSession.id, pid: previewSession.pid, status: previewSession.status })
      .from(previewSession)
      .where(
        and(
          eq(previewSession.projectId, projectId),
          notInArray(previewSession.status, [...TERMINAL])
        )
      );
    if (sessions.some((s) => BOOTING.has(s.status))) {
      return Response.json(
        { error: 'The editor is starting up for this project. Try again in a minute.' },
        { status: 409, headers }
      );
    }
    // Stop the rest (ready or paused): their branches are cut from the old
    // source and get deleted with it. The supervisor tears down its side on
    // the next tick; killing the pid here frees the tree right away.
    for (const session of sessions) {
      if (session.pid) {
        try {
          process.kill(session.pid, 'SIGTERM');
        } catch {
          // Already gone.
        }
      }
      await removeSessionUploads(session.id);
    }
    if (sessions.length) {
      const ids = sessions.map((s) => s.id);
      await db
        .update(previewSession)
        .set({
          status: 'closed',
          error: 'Replaced by a new import.',
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(previewSession.id, ids));
      await db
        .delete(previewAttachment)
        .where(inArray(previewAttachment.sessionId, ids));
      try {
        await client.notify('cp_preview', '');
      } catch {
        // The supervisor also polls.
      }
    }

    const { sha } = await replaceWorkspace({
      projectId,
      staging,
      name,
      author: authorFromHeaders(request),
    });
    void queueBackup(projectId, name);
    return Response.json(
      { projectId, files, framework: check.framework, sha },
      { status: 200, headers }
    );
  } catch (error) {
    if (error instanceof ZipError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    console.error('[imports] replace failed', error);
    return Response.json(
      { error: 'Import failed. The current site was not changed.' },
      { status: 500, headers }
    );
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }
};
