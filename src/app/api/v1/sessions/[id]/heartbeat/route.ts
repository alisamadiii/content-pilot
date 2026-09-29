import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { PREVIEW_SESSION_LIVE_STATUSES, previewSession } from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';

const LIVE = [...PREVIEW_SESSION_LIVE_STATUSES];

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

/**
 * Open-tab keep-alive. The hub pings this every minute while the project page
 * is open and visible, so the idle sweep pauses a session ~TTL after the tab
 * goes away instead of mid-use. Deliberately a no-op for paused/terminal
 * sessions — reviving is the create-or-join endpoint's job, and `ok: false`
 * tells the client to stop heartbeating.
 */
export const POST = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  const [row] = await db
    .select({ id: previewSession.id, repoId: previewSession.repoId, status: previewSession.status })
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== row.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  if (!LIVE.includes(row.status as (typeof LIVE)[number])) {
    return Response.json({ ok: false, status: row.status }, { status: 200, headers });
  }
  // Status re-checked in the WHERE so a concurrent pause isn't resurrected by
  // a stale in-flight heartbeat.
  await db
    .update(previewSession)
    .set({ lastActivityAt: new Date(), idleWarnedAt: null })
    .where(
      and(eq(previewSession.id, id), inArray(previewSession.status, LIVE))
    );
  return Response.json({ ok: true, status: row.status }, { status: 200, headers });
};
