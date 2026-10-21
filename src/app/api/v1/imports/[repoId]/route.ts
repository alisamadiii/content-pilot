import { eq, inArray } from 'drizzle-orm';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
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
import { extractCredentials } from '@/lib/request-credentials';
import {
  listDomainsForRepo,
  removeAllDomainsForRepo,
  removeRepoSettings,
} from '@/lib/settings';
import { removeSessionUploads } from '@/lib/uploads';
import { config } from '@/worker/config';
import { repoDir } from '@/worker/git';
import { hasLiveSite, liveUrlFor, removeLiveSnapshot } from '@/preview/live-serve';
import { latestLiveBuild, removeLiveBuilds } from '@/preview/live-build';
import { checkFramework } from '@/preview/framework';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only) management of a project's pilot state:
 *  - GET: does the workspace exist (hub's finalizeUpload verification), and
 *    the live site's state — URL, whether it has ever gone live, latest build.
 *  - DELETE: tear down EVERYTHING the pilot holds for the repo when the hub
 *    deletes the project — workspace clone, live snapshot, domain mappings,
 *    all preview sessions (+ their transcripts/events/attachments/staged
 *    uploads), and the per-repo settings overrides. Any live editing session
 *    is auto-closed (its dev server killed by pid), so delete never 409s.
 *    Runs for GitHub and upload projects alike.
 */

const authenticate = async (request: Request) => {
  const { apiKeyCandidate } = extractCredentials(request);
  return Boolean(await verifyApiKey(apiKeyCandidate));
};

const parseRepoId = (raw: string) => {
  const repoId = Number(raw);
  return Number.isSafeInteger(repoId) && repoId > 0 ? repoId : null;
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  const dir = repoDir(repoId);
  const exists = existsSync(join(dir, '.git'));
  let framework: string | null = null;
  if (exists) {
    // Sites live at the repo root; anything unsupported reports null.
    const check = checkFramework(dir);
    framework = check.ok ? check.framework : null;
  }
  const build = await latestLiveBuild(repoId);
  const domains = await listDomainsForRepo(repoId);
  return Response.json({
    exists,
    framework,
    liveUrl: liveUrlFor(repoId),
    live: hasLiveSite(repoId),
    build: build
      ? {
          id: build.id,
          status: build.status,
          sha: build.sha,
          error: build.error,
          log: build.log,
          createdAt: build.createdAt,
          finishedAt: build.finishedAt,
        }
      : null,
    domains,
  });
};

export const DELETE = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }

  // Every session for the repo. Live ones get their dev server killed by pid
  // (supervisor + this Next app share the container's pid namespace), which
  // frees the port; then all rows are pruned. No 409 — delete always proceeds.
  const sessions = await db
    .select({ id: previewSession.id, pid: previewSession.pid, status: previewSession.status })
    .from(previewSession)
    .where(eq(previewSession.repoId, repoId));
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
      .where(eq(previewSession.repoId, repoId));
  }

  // Path safety: same direct-child check as the admin workspaces delete.
  const base = resolve(config.workspaceDir);
  const target = resolve(join(base, String(repoId)));
  if (target === base || !target.startsWith(base + sep)) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }
  await removeLiveSnapshot(repoId);
  await removeLiveBuilds(repoId);
  // The live site's domains + per-repo setting overrides die with the project.
  await removeAllDomainsForRepo(repoId);
  await removeRepoSettings(repoId);
  try {
    await client.notify('cp_preview', '');
    await client.notify('cp_domains', '');
  } catch {
    // The supervisor also refreshes on an interval.
  }
  return Response.json({ deleted: true });
};
