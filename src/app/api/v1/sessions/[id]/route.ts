import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { previewConfig, previewUrlFor } from '@/preview/config';

const closeSchema = z.object({
  action: z.literal('close'),
  reason: z.enum(['discard', 'published']).optional(),
});

const loadAuthorized = async (request: Request, id: string) => {
  const auth = await authenticateSessionRequest(request);
  if (!auth) return { error: 401 as const };
  const [row] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) return { error: 404 as const };
  if (auth.kind === 'edit-token' && auth.payload.repoId !== row.repoId) {
    return { error: 403 as const };
  }
  return { row };
};

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const result = await loadAuthorized(request, id);
  if ('error' in result) {
    return Response.json({ error: 'Not available' }, { status: result.error, headers });
  }
  const row = result.row;
  // Read-only on purpose: polling the transcript is NOT activity. Idle expiry
  // is driven only by user messages, so we return lastActivityAt + idleMinutes
  // and let the client compute the countdown / show the idle warning.
  const messages = await db
    .select({
      id: previewMessage.id,
      role: previewMessage.role,
      content: previewMessage.content,
      status: previewMessage.status,
      commitSha: previewMessage.commitSha,
      error: previewMessage.error,
      createdAt: previewMessage.createdAt,
    })
    .from(previewMessage)
    .where(eq(previewMessage.sessionId, id))
    .orderBy(asc(previewMessage.id))
    .limit(200);
  return Response.json(
    {
      id: row.id,
      repoId: row.repoId,
      status: row.status,
      branch: row.branch,
      previewUrl: previewUrlFor(row.id),
      error: row.error,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      idleMinutes: previewConfig.idleMinutes,
      messages,
    },
    { status: 200, headers }
  );
};

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const result = await loadAuthorized(request, id);
  if ('error' in result) {
    return Response.json({ error: 'Not available' }, { status: result.error, headers });
  }
  const parsed = closeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400, headers });
  }

  // The API only writes the desired terminal state; the supervisor notices
  // and kills the dev server / prunes events on its next reconcile pass.
  const status = parsed.data.reason === 'published' ? 'published' : 'closed';
  await db
    .update(previewSession)
    .set({ status, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(previewSession.id, id));
  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }
  return Response.json({ id, status }, { status: 200, headers });
};
