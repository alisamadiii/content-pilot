import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';

const messageSchema = z.object({
  content: z.string().trim().min(2).max(4000),
  // Page/element context the hub attaches (viewed page + clicked element source
  // ref). Prepended to the prompt; never displayed. Optional.
  context: z.string().trim().max(2000).optional(),
});

// Mirrors the intake abuse guard: a runaway client can't queue unbounded work.
const MAX_PENDING_PER_SESSION = 5;

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

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
  const [session] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!session) {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== session.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }
  if (session.status !== 'ready' && session.status !== 'restarting') {
    return Response.json(
      { error: 'The preview is not ready yet. Please wait a moment.' },
      { status: 409, headers }
    );
  }

  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400, headers }
    );
  }

  const pending = await db
    .select({ id: previewMessage.id })
    .from(previewMessage)
    .where(
      and(
        eq(previewMessage.sessionId, id),
        inArray(previewMessage.status, ['queued', 'running'])
      )
    );
  if (pending.length >= MAX_PENDING_PER_SESSION) {
    return Response.json(
      { error: 'Too many pending requests. Please wait for the current ones to finish.' },
      { status: 429, headers }
    );
  }

  const [created] = await db
    .insert(previewMessage)
    .values({
      sessionId: id,
      role: 'user',
      content: parsed.data.content,
      context: parsed.data.context ?? null,
      status: 'queued',
    })
    .returning({ id: previewMessage.id });

  // Chat is activity — keep the idle sweep away while the client is typing.
  await db
    .update(previewSession)
    .set({ lastActivityAt: new Date() })
    .where(eq(previewSession.id, id));

  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }

  return Response.json({ messageId: created.id }, { status: 202, headers });
};
