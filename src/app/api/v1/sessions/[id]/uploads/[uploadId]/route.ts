import { and, eq } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { db } from '@/db';
import { previewAttachment } from '@/db/schema';
import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import { stagedFile } from '@/lib/uploads';

export const runtime = 'nodejs';

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

/**
 * Serves an uploaded image for the chat transcript thumbnail. Always the
 * staged bytes (never the clone), so the thumbnail survives discards and
 * branch resets. `?token=` is accepted because <img> cannot set headers.
 * Ended sessions still serve (the transcript stays readable).
 */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string; uploadId: string }> }
) => {
  const { id, uploadId } = await params;
  const loaded = await loadSessionForEdit(request, id, { allowTerminal: true });
  if ('response' in loaded) return loaded.response;
  const { headers } = loaded;

  const [row] = await db
    .select({ mime: previewAttachment.mime, stagedPath: previewAttachment.stagedPath })
    .from(previewAttachment)
    .where(and(eq(previewAttachment.id, uploadId), eq(previewAttachment.sessionId, id)))
    .limit(1);
  if (!row) {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(stagedFile(row.stagedPath));
  } catch {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': row.mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
};
