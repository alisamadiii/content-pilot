import { eq } from 'drizzle-orm';
import { copyFile, mkdir, stat } from 'fs/promises';
import { join, posix } from 'path';
import { db } from '@/db';
import { previewAttachment } from '@/db/schema';
import { EXT_BY_MIME, stagedFile, type AttachmentMime } from '@/lib/uploads';
import { chooseImageDir, listImageDirHints, slugify } from './image-dirs';
import type { Placed } from './placements';

/**
 * Chat image uploads, supervisor side. The agent never touches image bytes
 * (it cannot: no Bash, text-only Write, and the staged files live outside its
 * cwd). The SERVER picks each image's destination (folder from the site's own
 * conventions + a slug from the owner's description), copies the bytes into the
 * clone before the run, and tells the agent the final URL. The agent's only job
 * is to reference it. After the run the server checks that something changed
 * actually references each image.
 */

export type { AttachmentRow, Placed } from './placements';
export { buildAttachmentsBlock, verifyPlacements } from './placements';

type AttachmentRow = typeof previewAttachment.$inferSelect;

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
    // Empty publicRel (static root repos): dest is already root-relative — the
    // old slice would eat its first character.
    placed.push({
      row,
      dest,
      url: '/' + (publicRel ? dest.slice(publicRel.length + 1) : dest),
    });
  }
  return placed;
};
