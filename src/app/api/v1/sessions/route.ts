import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import {
  PREVIEW_SESSION_LIVE_STATUSES,
  job,
  previewSession,
} from '@/db/schema';
import { resolveRepo } from '@/lib/resolve-repo';
import { getMaxSessions } from '@/lib/settings';
import {
  authenticateSessionRequest,
  newSessionId,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { previewUrlFor } from '@/preview/config';

const LIVE = [...PREVIEW_SESSION_LIVE_STATUSES];

const createSchema = z.object({
  repoId: z.number().int().positive(),
  requestedBy: z.string().trim().max(200).optional(),
});

const publicSession = (row: typeof previewSession.$inferSelect) => ({
  id: row.id,
  repoId: row.repoId,
  owner: row.owner,
  repo: row.repo,
  status: row.status,
  branch: row.branch,
  previewUrl: previewUrlFor(row.id),
  error: row.error,
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
  if (auth.kind === 'edit-token' && auth.payload.repoId !== input.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }

  // One live session per repo — a second start joins the existing session
  // (two hub tabs / two collaborators share one preview).
  const [existing] = await db
    .select()
    .from(previewSession)
    .where(
      and(
        eq(previewSession.repoId, input.repoId),
        inArray(previewSession.status, LIVE)
      )
    )
    .limit(1);
  if (existing) {
    return Response.json(publicSession(existing), { status: 200, headers });
  }

  // The batch worker and a session must never share a working tree. New
  // batches are blocked by the claim guard; a batch already running blocks
  // session creation instead.
  const [runningJob] = await db
    .select({ id: job.id })
    .from(job)
    .where(and(eq(job.repoId, input.repoId), eq(job.status, 'running')))
    .limit(1);
  if (runningJob) {
    return Response.json(
      { error: 'An automatic edit is currently running for this site. Please try again in a minute.' },
      { status: 409, headers }
    );
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

  const resolved = await resolveRepo(input.repoId);
  if (!resolved) {
    return Response.json(
      { error: 'Unknown repository — could not resolve owner/repo from repoId.' },
      { status: 422, headers }
    );
  }

  const id = newSessionId();
  const [created] = await db
    .insert(previewSession)
    .values({
      id,
      repoId: input.repoId,
      owner: resolved.owner,
      repo: resolved.repo,
      branch: `preview/${id}`,
      status: 'starting',
      requestedBy: input.requestedBy,
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
  const repoIdRaw = new URL(request.url).searchParams.get('repoId');
  // No repoId → all live sessions (server-to-server only: the hub dashboard
  // lists a user's active sessions and filters to their repos itself).
  if (!repoIdRaw) {
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
  const repoId = Number(repoIdRaw);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return Response.json({ error: 'repoId required' }, { status: 400, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  // Failed and needs-config sessions are returned too (newest first) so the hub
  // can show the client-facing error / "ask your admin" panel instead of
  // silently resetting; closing one from the UI marks it 'closed' and clears it
  // from this lookup. needs_config isn't live, so a retry makes a fresh session.
  const [row] = await db
    .select()
    .from(previewSession)
    .where(
      and(
        eq(previewSession.repoId, repoId),
        inArray(previewSession.status, [...LIVE, 'failed', 'needs_config'])
      )
    )
    .orderBy(desc(previewSession.createdAt))
    .limit(1);
  return Response.json(
    { session: row ? publicSession(row) : null },
    { status: 200, headers }
  );
};
