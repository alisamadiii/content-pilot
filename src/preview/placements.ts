import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import type { previewAttachment } from '@/db/schema';
import { EXT_BY_MIME, type AttachmentMime } from '@/lib/uploads';
import { IMAGE_FILE } from './image-dirs';

// DB-free half of attachments.ts: the prompt block for uploads and the
// post-run "is every image referenced" check. Unit-tested without DATABASE_URL.

export type AttachmentRow = typeof previewAttachment.$inferSelect;

export type Placed = {
  row: AttachmentRow;
  /** Repo-relative file path, e.g. `public/images/team/ali-samadi.webp`. */
  dest: string;
  /** Public URL path the site should reference, e.g. `/images/team/ali-samadi.webp`. */
  url: string;
};

/** Text files larger than this are never scanned for an image reference. */
export const MENTION_SCAN_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The prompt block for a message with uploads. Appended after the hub context
 * / pinned file and before the owner's request. Both providers get it. Plain
 * punctuation only.
 */
export const buildAttachmentsBlock = (placed: Placed[]) => {
  const n = placed.length;
  return [
    'Uploaded images',
    '',
    `The site owner attached ${n} ${n === 1 ? 'image' : 'images'} to this request. The server has already saved ${n === 1 ? 'it' : 'them'} into the site at the URL ${n === 1 ? 'path' : 'paths'} below. Do NOT open, read, view or search for image files. Everything you need is here.`,
    '',
    placed
      .map(
        ({ row, url }, index) =>
          `${index + 1}. \`${url}\` (${EXT_BY_MIME[row.mime as AttachmentMime]}, ${row.width} x ${row.height}). Description: ${row.description || '(none given)'}`
      )
      .join('\n'),
    '',
    `Reference each image by that exact URL path in the component or CMS JSON, for example <img src="${placed[0].url}" alt="..."> or the matching JSON field. Use the description for the alt text. If the request does not say where an image goes, put it where the description suggests and tell the owner where it now appears.`,
  ].join('\n');
};

const mentions = async (dir: string, files: string[], needle: string) => {
  for (const file of files) {
    if (IMAGE_FILE.test(file)) continue;
    const abs = join(dir, file);
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MENTION_SCAN_MAX_BYTES) continue;
      const text = await readFile(abs, 'utf8');
      if (text.includes(needle) || text.includes(needle.slice(1))) return true;
    } catch {
      // deleted / unreadable: not a reference
    }
  }
  return false;
};

/**
 * After the agent run: every placed image must be referenced by some changed
 * text file. Returns a human-readable problem list for the repair prompt, or
 * null when all are referenced.
 */
export const verifyPlacements = async (params: {
  dir: string;
  placed: Placed[];
  changed: string[];
}): Promise<string | null> => {
  const problems: string[] = [];
  for (const { row, url } of params.placed) {
    if (!(await mentions(params.dir, params.changed, url))) {
      problems.push(
        `The image at \`${url}\` (${row.description || row.originalName}) is not referenced anywhere. Add it to the component or CMS JSON.`
      );
    }
  }
  return problems.length ? problems.join('\n') : null;
};
