import { eq } from 'drizzle-orm';
import { copyFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { join, posix, relative } from 'path';
import { db } from '@/db';
import { previewAttachment } from '@/db/schema';
import { EXT_BY_MIME, stagedFile, type AttachmentMime } from '@/lib/uploads';

/**
 * Chat image uploads, supervisor side. The agent never touches image bytes
 * (it cannot: no Bash, text-only Write, and the staged files live outside its
 * cwd). Instead the prompt describes each image and asks the agent to record
 * a destination in a git-excluded manifest; after the run the server copies
 * the bytes into place and checks the site actually references them.
 */

export type AttachmentRow = typeof previewAttachment.$inferSelect;

/** Repo-root-relative folder holding the agent's manifest. Git-excluded. */
export const PLACEMENTS_DIR = '.cp-uploads';
export const PLACEMENTS_FILE = `${PLACEMENTS_DIR}/placements.json`;

export const loadMessageAttachments = (messageId: number) =>
  db
    .select()
    .from(previewAttachment)
    .where(eq(previewAttachment.messageId, messageId))
    .orderBy(previewAttachment.createdAt);

/** `public` for root apps, `<appDir>/public` for subfolder apps. */
export const publicRelFor = (dir: string, appDir: string) => {
  const appDirRel = relative(dir, appDir).split('\\').join('/');
  return appDirRel ? `${appDirRel}/public` : 'public';
};

const IMAGE_FILE = /\.(webp|jpe?g|png|gif|avif|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

/**
 * Folders that already hold images, so the prompt can point the agent at the
 * site's own conventions ("public/images/projects (14 files)"). Cheap readdir,
 * bounded depth, top 20 by count.
 */
export const listImageDirHints = async (
  appDir: string,
  publicRel: string
): Promise<Array<{ dir: string; count: number }>> => {
  const counts = new Map<string, number>();
  const walk = async (abs: string, rel: string, depth: number) => {
    if (depth > 4) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        await walk(join(abs, entry.name), `${rel}/${entry.name}`, depth + 1);
      } else if (entry.isFile() && IMAGE_FILE.test(entry.name)) {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
      }
    }
  };
  // The prompt talks in repo-root-relative paths; publicRel already carries
  // the app subfolder prefix when there is one.
  const srcRel = publicRel.replace(/public$/, 'src');
  await walk(join(appDir, 'public'), publicRel, 0);
  await walk(join(appDir, 'src'), srcRel, 0);
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, 20);
};

const describe = (row: AttachmentRow, index: number) =>
  `${index + 1}. id: ${row.id}\n` +
  `   original file: ${row.originalName}\n` +
  `   format: ${EXT_BY_MIME[row.mime as AttachmentMime]} (${row.width} x ${row.height})\n` +
  `   description: ${row.description || '(none given)'}`;

/**
 * The prompt block for a message with uploads. Appended after the hub context
 * / pinned file and before the owner's request. Both providers get it (Gemini
 * prepends the same text). Plain punctuation only.
 */
export const buildAttachmentsBlock = (
  attachments: AttachmentRow[],
  publicRel: string,
  hints: Array<{ dir: string; count: number }>
) => {
  const n = attachments.length;
  const example = attachments[0];
  const exampleExt = EXT_BY_MIME[example.mime as AttachmentMime];
  const examplePath = `${publicRel}/images/projects/ortega-kitchen-remodel.${exampleExt}`;
  const exampleUrl = `/images/projects/ortega-kitchen-remodel.${exampleExt}`;
  const hintLine = hints.length
    ? `  Image folders that already exist in this site: ${hints
        .map((h) => `\`${h.dir}\` (${h.count} ${h.count === 1 ? 'file' : 'files'})`)
        .join(', ')}. If none fits, create a sensible new folder under \`${publicRel}/images/\`.`
    : `  This site has no image folders yet. Create a sensible one under \`${publicRel}/images/\`.`;
  const subfolderNote =
    publicRel === 'public'
      ? ''
      : ` All paths below are relative to the repo root; the app lives in \`${publicRel.replace(/\/public$/, '')}/\`.`;
  return [
    'Uploaded images',
    '',
    `The site owner attached ${n} ${n === 1 ? 'image' : 'images'} to this request. ${n === 1 ? 'It is' : 'They are'} already stored on the server. Do NOT open, read, or view image files (never call Read or read_file on a .webp, .jpg, .png or .gif path). Everything you need is written here. Use the description for alt text and to decide placement.${subfolderNote}`,
    '',
    attachments.map(describe).join('\n'),
    '',
    'For each image:',
    `- Choose its final path: a folder under \`${publicRel}/\` that matches where this site keeps similar images, plus a short descriptive kebab-case filename made from the description. Keep the extension exactly as listed. Example: \`${examplePath}\`.`,
    hintLine,
    `- Reference the image in the site code or CMS JSON by its public URL path, which is the chosen path without the \`${publicRel}\` prefix: \`${exampleUrl}\`.`,
    `- Record your decision by writing \`${PLACEMENTS_FILE}\` at the repo root, mapping each image id to its chosen path:`,
    `  {"${example.id}": "${examplePath}"}`,
    '  The server copies the image into place after your turn. Do not create, copy, or write the image file yourself, and do not mention placements.json to the owner.',
    'If the request does not say where an image goes, put it where the description suggests and tell the owner where it now appears.',
  ].join('\n');
};

const FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(webp|jpg|png|gif)$/;
const DIR_SEGMENT = /^[a-z0-9._-]+$/i;

export type PlacementCheck = { dest: string } | { error: string };

/**
 * Normalises and validates one manifest value into a repo-root-relative
 * destination under `publicRel`. Lenient about the forms a small model tends
 * to write (leading slash, the public URL path), strict about everything that
 * matters (traversal, folder, filename shape, extension).
 */
export const validatePlacement = (
  value: unknown,
  options: { publicRel: string; ext: string }
): PlacementCheck => {
  const { publicRel, ext } = options;
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'no path was given' };
  }
  let path = value.trim().split('\\').join('/');
  if (path.includes('\0')) return { error: 'the path contains an invalid character' };
  path = path.replace(/^\.\//, '');
  if (path.startsWith('/') && !path.startsWith(`/${publicRel}/`)) {
    // A bare public URL path ("/images/x.webp"): prefix the public folder.
    path = `${publicRel}${path}`;
  }
  path = path.replace(/^\/+/, '');
  path = posix.normalize(path);
  if (path.startsWith('../') || path === '..' || path.split('/').includes('..')) {
    return { error: 'the path must stay inside the site' };
  }
  if (!path.startsWith(`${publicRel}/`)) {
    return { error: `the path must be inside \`${publicRel}/\`` };
  }
  const segments = path.split('/');
  const file = segments[segments.length - 1];
  const dirs = segments.slice(publicRel.split('/').length, -1);
  if (dirs.length === 0) {
    return { error: `put it in a folder under \`${publicRel}/\`, not directly in it` };
  }
  for (const segment of dirs) {
    if (!DIR_SEGMENT.test(segment)) {
      return { error: `folder name \`${segment}\` is not allowed` };
    }
  }
  if (!FILENAME.test(file)) {
    return {
      error: `the filename must be lowercase kebab-case with the .${ext} extension, like \`ortega-kitchen-remodel.${ext}\``,
    };
  }
  if (!file.endsWith(`.${ext}`)) {
    return { error: `the extension must stay .${ext}` };
  }
  return { dest: path };
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
 * After the agent run: read the manifest, validate each destination, copy the
 * staged bytes into the clone, and require that some changed text file
 * references the image's public URL. Returns a human-readable problem list
 * for the repair prompt, or null when every image is placed and referenced.
 *
 * Copy (not move): a later discard + repair retry still has the bytes, and
 * `clean -fd` removes the untracked copy on any revert.
 */
export const applyPlacements = async (params: {
  dir: string;
  publicRel: string;
  attachments: AttachmentRow[];
  changed: string[];
}): Promise<string | null> => {
  const { dir, publicRel, attachments, changed } = params;
  const ids = attachments.map((a) => a.id);
  let manifest: Record<string, unknown> | null = null;
  try {
    const raw = await readFile(join(dir, PLACEMENTS_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as Record<string, unknown>;
    }
  } catch {
    manifest = null;
  }
  if (!manifest) {
    return `No \`${PLACEMENTS_FILE}\` was written (or it is not valid JSON). Expected {"<id>": "<path>"} with an entry for ${ids.length === 1 ? 'id' : 'ids'}: ${ids.join(', ')}.`;
  }

  const problems: string[] = [];
  for (const row of attachments) {
    const ext = EXT_BY_MIME[row.mime as AttachmentMime];
    if (!(row.id in manifest)) {
      problems.push(`Image ${row.id} (${row.description}) has no entry in placements.json.`);
      continue;
    }
    const check = validatePlacement(manifest[row.id], { publicRel, ext });
    if ('error' in check) {
      problems.push(`Image ${row.id}: ${check.error}.`);
      continue;
    }
    const dest = check.dest;
    const abs = join(dir, dest);
    if (row.placedPath !== dest && (await exists(abs))) {
      problems.push(`Image ${row.id}: \`${dest}\` already exists. Pick another filename.`);
      continue;
    }
    const publicUrl = '/' + dest.slice(publicRel.length + 1);
    if (!(await mentions(dir, changed, publicUrl))) {
      problems.push(
        `Image ${row.id} was placed at \`${dest}\` but nothing references \`${publicUrl}\`. Add it to the component or CMS JSON.`
      );
      // Still copy so a repair run that only adds the reference succeeds.
    }
    await mkdir(join(dir, posix.dirname(dest)), { recursive: true });
    await copyFile(stagedFile(row.stagedPath), abs);
    if (row.placedPath !== dest) {
      await db
        .update(previewAttachment)
        .set({ placedPath: dest })
        .where(eq(previewAttachment.id, row.id));
      row.placedPath = dest;
    }
  }
  return problems.length ? problems.join('\n') : null;
};
