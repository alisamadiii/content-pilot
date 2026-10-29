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
import { removeProjectSettings } from '@/lib/settings';
import { isProjectId } from '@/lib/project-id';
import { removeSessionUploads } from '@/lib/uploads';
import { config } from '@/worker/config';
import { repoDir } from '@/worker/git';
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
 *    Runs for GitHub and upload projects alike.
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
  return Response.json({ exists, framework });
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
