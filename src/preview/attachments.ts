import { eq } from 'drizzle-orm';
import { copyFile, mkdir, readFile, stat } from 'fs/promises';
import { join, posix } from 'path';
import { db } from '@/db';
import { previewAttachment } from '@/db/schema';
import { EXT_BY_MIME, stagedFile, type AttachmentMime } from '@/lib/uploads';
import { chooseImageDir, IMAGE_FILE, listImageDirHints, slugify } from './image-dirs';

/**
 * Chat image uploads, supervisor side. The agent never touches image bytes
 * (it cannot: no Bash, text-only Write, and the staged files live outside its
 * cwd). The SERVER picks each image's destination (folder from the site's own
 * conventions + a slug from the owner's description), copies the bytes into the
 * clone before the run, and tells the agent the final URL. The agent's only job
 * is to reference it. After the run the server checks that something changed
 * actually references each image.
 */

export type AttachmentRow = typeof previewAttachment.$inferSelect;

export const loadMessageAttachments = (messageId: number) =>
  db
    .select()
    .from(previewAttachment)
    .where(eq(previewAttachment.messageId, messageId))
    .orderBy(previewAttachment.createdAt);

export { chooseImageDir, listImageDirHints, publicRelFor, slugify } from './image-dirs';

// ---------------------------------------------------------------------------
// Destination planning
// ---------------------------------------------------------------------------

export type Placed = {
  row: AttachmentRow;
  /** Repo-relative file path, e.g. `public/images/team/ali-samadi.webp`. */
  dest: string;
  /** Public URL path the site should reference, e.g. `/images/team/ali-samadi.webp`. */
  url: string;
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Picks a destination for every attachment, copies the staged bytes into the
 * clone and records it on the row. Idempotent per message: a row that already
 * has `placedPath` (repair run, retried message) keeps it. Copy, not move: a
 * later discard + retry still has the bytes, and `clean -fd` removes the
 * untracked copy on any revert.
 */
export const planPlacements = async (params: {
  dir: string;
  appDir: string;
  publicRel: string;
  attachments: AttachmentRow[];
}): Promise<Placed[]> => {
  const { dir, appDir, publicRel, attachments } = params;
  const hints = await listImageDirHints(appDir, publicRel);
  const placed: Placed[] = [];
  const taken = new Set<string>();
  for (const row of attachments) {
    const ext = EXT_BY_MIME[row.mime as AttachmentMime];
    let dest = row.placedPath;
    if (!dest) {
      const folder = chooseImageDir(row.description ?? '', hints, publicRel);
      const stem = slugify(
        row.description || row.originalName.replace(/\.[^.]+$/, '')
      );
      dest = `${folder}/${stem}.${ext}`;
      for (let n = 2; taken.has(dest) || (await exists(join(dir, dest))); n++) {
        dest = `${folder}/${stem}-${n}.${ext}`;
      }
    }
    taken.add(dest);
    await mkdir(join(dir, posix.dirname(dest)), { recursive: true });
    await copyFile(stagedFile(row.stagedPath), join(dir, dest));
    if (row.placedPath !== dest) {
      await db
        .update(previewAttachment)
        .set({ placedPath: dest })
        .where(eq(previewAttachment.id, row.id));
      row.placedPath = dest;
    }
    placed.push({ row, dest, url: '/' + dest.slice(publicRel.length + 1) });
  }
  return placed;
};

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
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
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
