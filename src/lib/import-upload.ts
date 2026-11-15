import { createWriteStream } from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { ZipError } from '@/worker/zip-extract';

/**
 * Request plumbing shared by the first import (POST /api/v1/imports) and the
 * replace (PUT /api/v1/imports/:projectId). The body is a raw zip stream
 * (`Content-Type: application/zip`), never multipart: `request.formData()`
 * would buffer the whole archive in memory.
 */

export const MAX_ZIP_BYTES = 100 * 1024 * 1024;

/** One header line of commit identity, length-capped; null when absent. */
export const authorFromHeaders = (request: Request) => {
  const name = (request.headers.get('x-author-name') || '').trim().slice(0, 200);
  const email = (request.headers.get('x-author-email') || '')
    .trim()
    .slice(0, 320);
  return name && email ? { name, email } : null;
};

/** 413 from the declared length alone, before reading anything. */
export const declaredTooLarge = (request: Request) =>
  Number(request.headers.get('content-length') || 0) > MAX_ZIP_BYTES;

/**
 * Stream the body to `zipPath`, counting real bytes (content-length can lie).
 * Counting happens in-pipeline: a bare 'data' listener would start the flow
 * before the file stream is attached and drop bytes.
 */
export const receiveZip = async (request: Request, zipPath: string) => {
  if (!request.body) throw new ZipError('Empty body', 400);
  let received = 0;
  const body = Readable.fromWeb(
    request.body as import('stream/web').ReadableStream
  );
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ZIP_BYTES) {
        callback(new ZipError('Zip is larger than 100 MB.', 413));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(body, counter, createWriteStream(zipPath));
};
