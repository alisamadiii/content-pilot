import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import {
  PREVIEW_SESSION_LIVE_STATUSES,
  previewSession,
} from '@/db/schema';
import { existsSync } from 'fs';
import { join } from 'path';
import { repoDir } from '@/worker/git';
import { isProjectId } from '@/lib/project-id';
import { getGeminiTier, getMaxSessions, getProvider } from '@/lib/settings';
import {
  authenticateSessionRequest,
  newSessionId,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { previewUrlFor } from '@/preview/config';
import { isPreviewBranch, isValidBranchName } from '@/preview/branch-name';

const LIVE = [...PREVIEW_SESSION_LIVE_STATUSES];

const createSchema = z.object({
  /** The hub project (hub_project.id). Keys the workspace dir + settings. */
  projectId: z.string().uuid(),
  requestedBy: z.string().trim().max(200).optional(),
  /**
   * Named branch to run the session ON (commits land there and persist).
   * Omitted = the default-branch preview on an ephemeral `preview/<id>`.
   */
  branch: z.string().trim().min(1).max(100).optional(),
  /**
   * The repo's slug. Required: GitHub ops (clone/fetch/push, installation
   * tokens) go by owner/repo; uploads use it as their display identity.
   */
  owner: z.string().trim().min(1).max(100).optional(),
  repo: z.string().trim().min(1).max(200).optional(),
  /**
   * Commit identity for this session's pushes (the project owner's GitHub
   * login + noreply email, derived from the App installation by the hub).
   * Omitted → the GIT_AUTHOR_* env fallback (the app bot).
   */
  commitAuthorName: z.string().trim().min(1).max(200).optional(),
  commitAuthorEmail: z.string().trim().min(1).max(320).optional(),
  /**
   * Workspace source. 'upload' = extracted zip with local-only git (no clone,
   * no pushes) — the hub passes it for projects it created via importUpload.
   * Omitted/'github' = today's clone-and-push flow.
   */
  source: z.enum(['github', 'upload']).optional(),
});

/** Two sessions are "the same branch" when both are named-and-equal, or both are default previews. */
const sameBranch = (existing: string, requested: string | undefined) =>
  requested === undefined ? isPreviewBranch(existing) : existing === requested;

const publicSession = (row: typeof previewSession.$inferSelect) => ({
  id: row.id,
  projectId: row.projectId,
  source: row.source,
  owner: row.owner,
  repo: row.repo,
  status: row.status,
  branch: row.branch,
  previewUrl: previewUrlFor(row.id),
  error: row.error,
  provider: row.provider,
  createdAt: row.createdAt,
});

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

export const POST = async (request: Request) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400, headers }
    );
  }
  const input = parsed.data;
  if (auth.kind === 'edit-token' && auth.payload.projectId !== input.projectId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  if (input.branch !== undefined && !isValidBranchName(input.branch)) {
    return Response.json(
      { error: 'Invalid branch name.' },
      { status: 400, headers }
    );
  }

  // One live session per project — a second start joins the existing session
  // (two hub tabs / two collaborators share one preview). A paused session is
  // joined too: it's revived below instead of creating a fresh one, so the
  // branch, conversation, and any unpublished edits carry over.
  const [existing] = await db
    .select()
    .from(previewSession)
    .where(
      and(
        eq(previewSession.projectId, input.projectId),
        inArray(previewSession.status, [...LIVE, 'paused'])
      )
    )
    .limit(1);
  // A session on another branch can't be joined: one clone per project means one
  // checked-out branch. The hub closes the old session before asking for a new
  // branch, so this only fires on a race between two tabs.
  if (existing && !sameBranch(existing.branch, input.branch)) {
    return Response.json(
      { error: 'branch_mismatch', session: publicSession(existing) },
      { status: 409, headers }
    );
  }
  if (existing && existing.status !== 'paused') {
    return Response.json(publicSession(existing), { status: 200, headers });
  }

  const activeRows = await db
    .select({ id: previewSession.id })
    .from(previewSession)
    .where(inArray(previewSession.status, LIVE));
  if (activeRows.length >= (await getMaxSessions())) {
    return Response.json(
      { error: 'All preview slots are busy right now. Please try again in a few minutes.' },
      { status: 429, headers }
    );
  }

  // Revive a paused session in place: flip back to 'starting' and let the
  // supervisor relaunch against the warm workspace. Same slot accounting as a
  // fresh session (checked above).
  if (existing) {
    const [revived] = await db
      .update(previewSession)
      .set({
        status: 'starting',
        error: null,
        lastActivityAt: new Date(),
        idleWarnedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(previewSession.id, existing.id))
      .returning();
    try {
      await client.notify('cp_preview', '');
    } catch {
      // supervisor also polls
    }
    return Response.json(publicSession(revived), { status: 200, headers });
  }

  if (!input.owner || !input.repo) {
    return Response.json(
      { error: 'owner and repo are required.' },
      { status: 400, headers }
    );
  }
  const resolved = { owner: input.owner, repo: input.repo };
  if (input.source === 'upload') {
    // Upload workspaces must already exist (imports route); they can never
    // be re-cloned.
    if (!existsSync(join(repoDir(input.projectId), '.git'))) {
      return Response.json(
        {
          error:
            "This uploaded project's files are missing from the preview server. Re-import the project to continue.",
        },
        { status: 422, headers }
      );
    }
  }

  const id = newSessionId();
  // Provider is bound now and never re-read — a mid-life setting change only
  // affects the next fresh session (resume ids are provider-specific).
  const provider = await getProvider(input.projectId);
  const [created] = await db
    .insert(previewSession)
    .values({
      id,
      projectId: input.projectId,
      source: input.source ?? 'github',
      owner: resolved.owner,
      repo: resolved.repo,
      branch: input.branch ?? `preview/${id}`,
      status: 'starting',
      provider,
      requestedBy: input.requestedBy,
      commitAuthorName: input.commitAuthorName,
      commitAuthorEmail: input.commitAuthorEmail,
    })
    .returning();

  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }

  return Response.json(publicSession(created), { status: 201, headers });
};

export const GET = async (request: Request) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  const projectIdRaw = new URL(request.url).searchParams.get('projectId');
  // No projectId → all live sessions (server-to-server only: the hub dashboard
  // lists a user's active sessions and filters to their repos itself).
  if (!projectIdRaw) {
    if (auth.kind !== 'api-key') {
      return Response.json({ error: 'Forbidden' }, { status: 403, headers });
    }
    const liveRows = await db
      .select()
      .from(previewSession)
      .where(inArray(previewSession.status, LIVE))
      .orderBy(desc(previewSession.createdAt));
    return Response.json(
      { sessions: liveRows.map(publicSession) },
      { status: 200, headers }
    );
  }
  const projectId = projectIdRaw;
  if (!isProjectId(projectId)) {
    return Response.json({ error: 'projectId required' }, { status: 400, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.projectId !== projectId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  // Failed sessions are returned too (newest first) so the hub can show the
  // client-facing error instead of silently resetting; closing one from the UI
  // marks it 'closed' and clears it from this lookup. Failed isn't live, so a
  // retry makes a fresh session.
  const [row] = await db
    .select()
    .from(previewSession)
    .where(
      and(
        eq(previewSession.projectId, projectId),
        inArray(previewSession.status, [...LIVE, 'paused', 'failed'])
      )
    )
    .orderBy(desc(previewSession.createdAt))
    .limit(1);
  return Response.json(
    {
      session: row
        ? { ...publicSession(row), geminiTier: await getGeminiTier(projectId) }
        : null,
    },
    { status: 200, headers }
  );
};
