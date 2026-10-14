import { and, count, eq, isNull } from 'drizzle-orm';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { db } from '@/db';
import { previewAttachment, previewSession } from '@/db/schema';
import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import {
  ATTACHMENT_MAX_BYTES,
  EXT_BY_MIME,
  MAX_UNBOUND_PER_SESSION,
  newAttachmentId,
  sessionUploadsDir,
  sniffImage,
  USER_MESSAGES,
} from '@/lib/uploads';

export const runtime = 'nodejs';

// The browser already shrank the image to <= 1 MB; anything bigger on the wire
// is either an oversize original or abuse. Checked before the body is read
// because route handlers have no built-in cap and formData() buffers.
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const fieldsSchema = z.object({
  width: z.coerce.number().int().min(1).max(20000),
  height: z.coerce.number().int().min(1).max(20000),
  originalName: z.string().trim().min(1).max(200).optional(),
});

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

/**
 * Receives one chat image (multipart: `file`, `width`, `height`,
 * `originalName?`). Validates size + magic bytes, stages the bytes outside the
 * clone and inserts an unbound attachment row. The message that carries it
 * binds it later (POST /messages with `attachments`).
 */
export const POST = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const loaded = await loadSessionForEdit(request, id);
  if ('response' in loaded) return loaded.response;
  const { headers } = loaded;

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return Response.json({ error: USER_MESSAGES.tooLarge }, { status: 413, headers });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'Invalid upload' }, { status: 400, headers });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Invalid upload' }, { status: 400, headers });
  }
  const fields = fieldsSchema.safeParse({
    width: form.get('width'),
    height: form.get('height'),
    originalName: form.get('originalName') ?? undefined,
  });
  if (!fields.success) {
    return Response.json({ error: 'Invalid upload' }, { status: 400, headers });
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return Response.json({ error: USER_MESSAGES.tooLarge }, { status: 413, headers });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(bytes);
  if ('reject' in sniffed) {
    const error =
      sniffed.reject === 'svg'
        ? USER_MESSAGES.svg
        : sniffed.reject === 'heic'
          ? USER_MESSAGES.heic
          : USER_MESSAGES.notImage;
    return Response.json({ error }, { status: 415, headers });
  }

  const [{ unbound }] = await db
    .select({ unbound: count() })
    .from(previewAttachment)
    .where(
      and(eq(previewAttachment.sessionId, id), isNull(previewAttachment.messageId))
    );
  if (unbound >= MAX_UNBOUND_PER_SESSION) {
    return Response.json(
      { error: USER_MESSAGES.tooManyPending },
      { status: 429, headers }
    );
  }

  const attachmentId = newAttachmentId();
  const ext = EXT_BY_MIME[sniffed.mime];
  const stagedPath = `${id}/${attachmentId}.${ext}`;
  const dir = sessionUploadsDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${attachmentId}.${ext}`), bytes);

  const originalName = (fields.data.originalName ?? file.name ?? 'image').slice(0, 200);
  await db.insert(previewAttachment).values({
    id: attachmentId,
    sessionId: id,
    originalName,
    mime: sniffed.mime,
    bytes: bytes.byteLength,
    width: fields.data.width,
    height: fields.data.height,
    stagedPath,
  });

  // An upload is activity: keep the idle sweep off a client mid-attach.
  await db
    .update(previewSession)
    .set({ lastActivityAt: new Date(), idleWarnedAt: null })
    .where(eq(previewSession.id, id));

  return Response.json(
    {
      id: attachmentId,
      originalName,
      mime: sniffed.mime,
      bytes: bytes.byteLength,
      width: fields.data.width,
      height: fields.data.height,
    },
    { status: 201, headers }
  );
};
