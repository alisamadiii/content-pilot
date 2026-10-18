import { execFile } from 'child_process';
import { isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';
import { git } from '../worker/git';

const execFileAsync = promisify(execFile);

/**
 * Helpers behind the per-file diff + session changes routes. The hub shows
 * the AI's edits as GitHub-style before/after; both sides come from git (one
 * commit per turn), never from the tool_use payloads, so Claude and Gemini
 * sessions read the same way.
 */

/** Images are never text-diffed (binary; also never shown to the agent). */
export const IMAGE_PATH = /\.(webp|jpe?g|png|gif|avif|ico|svg)$/i;

/** 200 KB per side — plenty for source files, keeps the hub dialog snappy. */
export const MAX_DIFF_BYTES = 200_000;

/** 3 MB per side for image previews (inlined as data URLs). */
export const MAX_IMAGE_DIFF_BYTES = 3 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** MIME for an image path by extension; null for non-images. */
export const imageMime = (path: string): string | null => {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return IMAGE_MIME[ext] ?? null;
};

export type ImageAtRev = { dataUrl: string } | { tooLarge: true };

/**
 * `git show <rev>:<path>` as a data URL for the hub's image before/after
 * (chat uploads land as new .webp files; the Changes dialog shows them side
 * by side instead of "could not load"). Null when the file does not exist at
 * that rev; `tooLarge` above MAX_IMAGE_DIFF_BYTES.
 */
export const showImageAt = async (
  dir: string,
  rev: string,
  path: string
): Promise<ImageAtRev | null> => {
  const mime = imageMime(path);
  if (!mime) return null;
  try {
    const { stdout } = await execFileAsync('git', ['show', `${rev}:${path}`], {
      cwd: dir,
      encoding: 'buffer',
      maxBuffer: MAX_IMAGE_DIFF_BYTES * 4,
    });
    if (stdout.length > MAX_IMAGE_DIFF_BYTES) return { tooLarge: true };
    return { dataUrl: `data:${mime};base64,${stdout.toString('base64')}` };
  } catch {
    return null;
  }
};

/**
 * Repo-relative path for a tool's `file_path` (absolute inside the clone, or
 * already relative). Null for anything that escapes the clone.
 */
export const resolveRepoPath = (dir: string, input: string): string | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const rel = relative(dir, resolve(dir, trimmed));
  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
};

export const isFullSha = (value: string) => /^[0-9a-f]{40}$/.test(value);

/** `git show <rev>:<path>` — null when the file does not exist at that rev. */
export const showFileAt = async (
  dir: string,
  rev: string,
  path: string
): Promise<{ text: string; truncated: boolean } | null> => {
  try {
    const text = await git(dir, ['show', `${rev}:${path}`]);
    return text.length > MAX_DIFF_BYTES
      ? { text: text.slice(0, MAX_DIFF_BYTES), truncated: true }
      : { text, truncated: false };
  } catch {
    return null;
  }
};

export type ChangedFile = {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
};

/** Parses `git diff --name-status` (renames keep the new path). */
export const parseNameStatus = (output: string): ChangedFile[] => {
  const files: ChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const letter = (code ?? '').charAt(0);
    const path = rest[rest.length - 1];
    if (!path) continue;
    if (letter === 'A' || letter === 'M' || letter === 'D') {
      files.push({ path, status: letter });
    } else if (letter === 'R' || letter === 'C') {
      files.push({ path, status: 'R' });
    } else {
      files.push({ path, status: 'M' });
    }
  }
  return files;
};
