import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import { config } from '../worker/config';

/**
 * Chat image uploads. Shared by the Next routes (receive + serve) and the
 * supervisor (place into the clone after the agent run). Pure helpers only —
 * no DB access here so both processes can import it freely.
 *
 * Bytes are staged OUTSIDE every repo clone, under
 * `<WORKSPACE_DIR>/.uploads/<sessionId>/<id>.<ext>`: they can never reach
 * `git add -A`, and neither agent (both confined to the clone as cwd) can
 * open them. The agent only ever sees the owner's description.
 */

/** Hard cap, enforced in the browser (after shrinking) and here. */
export const ATTACHMENT_MAX_BYTES = 1_048_576;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Uploaded but not yet sent with a message — guards a runaway client. */
export const MAX_UNBOUND_PER_SESSION = 30;

export type AttachmentMime =
  | 'image/webp'
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif';

export const EXT_BY_MIME: Record<AttachmentMime, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};

/** Client-facing copy. The hub mirrors these strings verbatim. */
export const USER_MESSAGES = {
  tooLarge: 'Images must be under 1 MB',
  tooMany: 'You can attach up to 10 images per message.',
  svg: 'SVG files are not supported. Please upload a JPG, PNG, WebP or GIF.',
  heic: 'HEIC photos are not supported here. Please export the photo as JPG or PNG first.',
  notImage:
    "Videos can't be uploaded here. Host it on YouTube, Vimeo or your own CDN and paste the link in the chat.",
  tooManyPending:
    'Too many pending images. Send a message with the images you have attached first.',
  gone: 'One of the attached images is no longer available. Please remove it and attach it again.',
} as const;

export const uploadsRoot = () => join(config.workspaceDir, '.uploads');
export const sessionUploadsDir = (sessionId: string) =>
  join(uploadsRoot(), sessionId);
export const stagedFile = (stagedPath: string) => join(uploadsRoot(), stagedPath);

export const removeSessionUploads = async (sessionId: string) => {
  await rm(sessionUploadsDir(sessionId), { recursive: true, force: true });
};

// Lowercase alphanumeric, same alphabet as session ids: safe as a file stem.
export const newAttachmentId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(10);
  let id = '';
  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }
  return id;
};

export const ATTACHMENT_ID_PATTERN = /^[a-z0-9]{10}$/;

export type SniffResult =
  | { mime: AttachmentMime }
  | { reject: 'svg' | 'heic' | 'not-image' };

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
]);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Magic-byte detection — the client's mime/extension is never trusted. SVG and
 * HEIC are recognised only to give a precise error; everything else that is
 * not one of the four stored formats is "not an image" (the video message).
 */
export const sniffImage = (bytes: Uint8Array): SniffResult => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: 'image/png' };
  }
  if (bytes.length >= 6) {
    const head = ascii(bytes, 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return { mime: 'image/gif' };
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp' };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') {
    if (HEIF_BRANDS.has(ascii(bytes, 8, 12).toLowerCase())) return { reject: 'heic' };
  }
  // Text-ish start: BOM / whitespace, then `<`. Only look at the first KB.
  const probe = ascii(bytes, 0, Math.min(bytes.length, 1024))
    .replace(/^﻿|^\xEF\xBB\xBF/, '')
    .trimStart();
  if (probe.startsWith('<') && /<svg[\s>]|<\?xml/i.test(probe)) {
    return { reject: 'svg' };
  }
  return { reject: 'not-image' };
};
