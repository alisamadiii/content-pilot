import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import { previewAttachment, previewMessage, previewSession } from '@/db/schema';
import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import {
  ATTACHMENT_ID_PATTERN,
  MAX_ATTACHMENTS_PER_MESSAGE,
  USER_MESSAGES,
} from '@/lib/uploads';

const messageSchema = z.object({
  content: z.string().trim().min(2).max(20000),
  // Page/element context the hub attaches (viewed page + clicked element source
  // ref). Prepended to the prompt; never displayed. Optional.
  context: z.string().trim().max(2000).optional(),
  // Images uploaded earlier via POST /uploads, each with the owner's one-line
  // description (the AI never opens the file). Bound to this message here.
  attachments: z
    .array(
      z.object({
        id: z.string().regex(ATTACHMENT_ID_PATTERN),
        description: z.string().trim().min(3).max(200),
      })
    )
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .optional(),
});

// Mirrors the intake abuse guard: a runaway client can't queue unbounded work.
const MAX_PENDING_PER_SESSION = 5;

class AttachmentGoneError extends Error {}

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
  const { id } = await params;
  // Messages are accepted for any revivable session and queue until the dev
  // server is ready (the pump only runs against ready sessions). Only broken /
  // finished sessions reject (loadSessionForEdit's 409).
  const loaded = await loadSessionForEdit(request, id);
  if ('response' in loaded) return loaded.response;
  const { session, headers } = loaded;

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

  const attachments = parsed.data.attachments ?? [];
  const attachmentIds = attachments.map((a) => a.id);
  let created: { id: number };
  try {
    created = await db.transaction(async (tx) => {
      if (attachmentIds.length) {
        // Every id must be this session's and still unbound; a stale/foreign
        // id means the client's tray and the server disagree — refuse whole.
        const rows = await tx
          .select({ id: previewAttachment.id })
          .from(previewAttachment)
          .where(
            and(
              eq(previewAttachment.sessionId, id),
              isNull(previewAttachment.messageId),
              inArray(previewAttachment.id, attachmentIds)
            )
          );
        if (rows.length !== new Set(attachmentIds).size) {
          throw new AttachmentGoneError();
        }
      }
      const [row] = await tx
        .insert(previewMessage)
        .values({
          sessionId: id,
          role: 'user',
          content: parsed.data.content,
          context: parsed.data.context ?? null,
          status: 'queued',
        })
        .returning({ id: previewMessage.id });
      for (const attachment of attachments) {
        await tx
          .update(previewAttachment)
          .set({ messageId: row.id, description: attachment.description })
          .where(eq(previewAttachment.id, attachment.id));
      }
      return row;
    });
  } catch (error) {
    if (error instanceof AttachmentGoneError) {
      return Response.json({ error: USER_MESSAGES.gone }, { status: 400, headers });
    }
    throw error;
  }

  // Chat counts as activity — reset the idle clock and clear any pending idle
  // warning. A message to a paused session also revives it: flip to
  // 'starting' so the supervisor relaunches the dev server, then the queued
  // message runs once it's ready.
  await db
    .update(previewSession)
    .set({
      lastActivityAt: new Date(),
      idleWarnedAt: null,
      ...(session.status === 'paused' ? { status: 'starting' as const, error: null } : {}),
    })
    .where(eq(previewSession.id, id));

  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }

  return Response.json({ messageId: created.id }, { status: 202, headers });
};
