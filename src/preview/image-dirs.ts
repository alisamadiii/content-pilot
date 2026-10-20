import { readdir } from 'fs/promises';
import { join, relative } from 'path';

// DB-free helpers shared by attachments.ts (needs the DB) and repo-context /
// prompt-context (unit-tested without a DATABASE_URL).

/** `public` for root apps, `<appDir>/public` for subfolder apps. */
export const publicRelFor = (dir: string, appDir: string) => {
  const appDirRel = relative(dir, appDir).split('\\').join('/');
  return appDirRel ? `${appDirRel}/public` : 'public';
};

export const IMAGE_FILE = /\.(webp|jpe?g|png|gif|avif|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

/**
 * Folders that already hold images, so placement can follow the site's own
 * conventions ("public/images/projects (14 files)"). Cheap readdir, bounded
 * depth, top 20 by count. Paths are repo-root-relative; publicRel already
 * carries the app subfolder prefix when there is one.
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
  if (publicRel.endsWith('public')) {
    const srcRel = publicRel.replace(/public$/, 'src');
    await walk(join(appDir, 'public'), publicRel, 0);
    await walk(join(appDir, 'src'), srcRel, 0);
  } else {
    // Static repos serve from the app dir itself ('' for root apps): walk the
    // conventional root image folders instead of a public/ that doesn't exist.
    for (const name of ['images', 'img', 'assets', 'uploads', 'media']) {
      await walk(
        join(appDir, name),
        publicRel ? `${publicRel}/${name}` : name,
        0
      );
    }
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, 20);
};

// ---------------------------------------------------------------------------
// Destination planning (pure)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'to',
  'is', 'this', 'that', 'my', 'our', 'image', 'photo', 'picture', 'pic', 'img',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'new', 'upload', 'uploaded', 'file',
]);

/** Lowercase kebab-case stem from free text, ≤ 60 chars; never empty. */
export const slugify = (text: string, fallback = 'image') => {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((word) => word && !STOP_WORDS.has(word))
    .join('-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

/** Singular/plural-insensitive prefix match ("team" ~ "teams", "project" ~ "projects"). */
const sameWord = (a: string, b: string) =>
  a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));

/**
 * Folder for a new image: an existing image folder whose name matches a word
 * from the description ("team photo" → public/images/team), else a dedicated
 * uploads folder. Only folders under `<publicRel>/` qualify — `src/` assets
 * need an import, which a content edit should not introduce.
 */
export const chooseImageDir = (
  description: string,
  hints: Array<{ dir: string; count: number }>,
  publicRel: string
): string => {
  const wanted = words(description);
  // '' publicRel (static root repos): every hint qualifies and paths keep no
  // leading slash. Non-empty behavior is byte-identical to before.
  const prefix = publicRel ? `${publicRel}/` : '';
  let best: { dir: string; count: number } | null = null;
  for (const hint of hints) {
    if (prefix && !hint.dir.startsWith(prefix)) continue;
    const segments = hint.dir.slice(prefix.length).split('/');
    const last = segments[segments.length - 1];
    if (last === 'images' || last === 'img' || last === 'assets') continue;
    const hit = wanted.some((word) =>
      segments.some((segment) =>
        segment.split(/[-_]/).some((part) => sameWord(word, part))
      )
    );
    if (hit && (!best || hint.count > best.count)) best = hint;
  }
  return best?.dir ?? `${prefix}images/uploads`;
};
