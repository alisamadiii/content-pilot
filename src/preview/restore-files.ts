import { rm } from 'fs/promises';
import { join } from 'path';
import { findSessionForbiddenPaths } from '../worker/guardrails';
import { baseRef, git } from '../worker/git';
import { parseNameStatus } from './file-diff';

/**
 * Manual revert for the hub's Changes dialog (the "Revert" button on a file).
 * Puts the given files/folders back to their production state in the
 * session clone — edited files restored, added files removed, deleted files
 * brought back. Never exposed to the AI: the owner clicks it, the revert
 * route commits it.
 *
 * Production = `merge-base origin/<default> HEAD`, the same base the Changes
 * dialog diffs against, so "revert" and "what changed" agree. Forbidden paths
 * (secrets, package.json, lockfiles, CI) are skipped and reported.
 */

export type SessionChange = { path: string; status: 'A' | 'M' | 'D' };

export type RestoreResult =
  | {
      ok: true;
      base: string;
      restored: string[];
      removed: string[];
      skipped: string[];
    }
  | { ok: false; error: string };

export const MAX_RESTORE_PATHS = 50;

/** Whole-site selector: everything the session changed. */
export const EVERYTHING = '.';

/**
 * Cleans a path list: trims, strips "./" and leading "/", drops duplicates
 * and trailing slashes. Refuses anything that could escape the clone ("..",
 * backslashes) and over-long lists. "." (whole site) is kept as is.
 */
export const normalizeRestorePaths = (
  paths: string[]
): { ok: true; paths: string[] } | { ok: false; error: string } => {
  const out: string[] = [];
  for (const raw of paths) {
    let path = raw.trim();
    if (!path) continue;
    if (path === EVERYTHING || path === './') {
      if (!out.includes(EVERYTHING)) out.push(EVERYTHING);
      continue;
    }
    if (path.includes('\\')) {
      return { ok: false, error: `"${raw}" is not a valid path (use forward slashes).` };
    }
    while (path.startsWith('./')) path = path.slice(2);
    path = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) continue;
    const segments = path.split('/');
    if (segments.some((segment) => segment === '..' || segment === '')) {
      return { ok: false, error: `"${raw}" is outside the site and cannot be restored.` };
    }
    if (!out.includes(path)) out.push(path);
  }
  if (!out.length) return { ok: false, error: 'No paths given — nothing to restore.' };
  if (out.length > MAX_RESTORE_PATHS) {
    return {
      ok: false,
      error: `${out.length} paths is more than ${MAX_RESTORE_PATHS}. Pass a folder, or ["."] to restore everything.`,
    };
  }
  // "." covers everything; keep it alone so pathspecs stay simple.
  return { ok: true, paths: out.includes(EVERYTHING) ? [EVERYTHING] : out };
};

/** The production commit this session branched from (what Publish diffs against). */
export const productionBase = async (dir: string) => {
  // origin/<default> for GitHub clones, local <default> for uploads.
  return git(dir, ['merge-base', await baseRef(dir), 'HEAD']);
};

const scopeArgs = (paths: string[] | undefined) =>
  paths && paths.length && !paths.includes(EVERYTHING) ? ['--', ...paths] : [];

/**
 * Files changed between production and the working tree (committed turns,
 * the current turn's uncommitted edits, and untracked additions), optionally
 * limited to `paths`. Renames are reported as their two halves so a restore
 * can act on each path.
 */
export const listSessionChanges = async (
  dir: string,
  paths?: string[],
  base?: string
): Promise<{ base: string; files: SessionChange[] }> => {
  const resolvedBase = base ?? (await productionBase(dir));
  const scope = scopeArgs(paths);
  const tracked = await git(dir, [
    'diff',
    '--name-status',
    '--no-renames',
    resolvedBase,
    ...scope,
  ]);
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', ...scope]);
  const seen = new Map<string, SessionChange>();
  for (const file of parseNameStatus(tracked)) {
    seen.set(file.path, { path: file.path, status: file.status === 'R' ? 'M' : file.status });
  }
  for (const path of untracked.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (!seen.has(path)) seen.set(path, { path, status: 'A' });
  }
  // Byte order (not locale) so the list is stable across machines.
  const files = [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { base: resolvedBase, files };
};

export const restoreFiles = async (params: {
  dir: string;
  paths: string[];
}): Promise<RestoreResult> => {
  const normalized = normalizeRestorePaths(params.paths);
  if (!normalized.ok) return normalized;
  let base: string;
  try {
    base = await productionBase(params.dir);
  } catch {
    return { ok: false, error: 'Could not determine the live-site version to restore from.' };
  }
  const { files } = await listSessionChanges(params.dir, normalized.paths, base);
  const forbidden = new Set(findSessionForbiddenPaths(files.map((file) => file.path)));

  const skipped: string[] = [];
  const toRemove: string[] = [];
  const toCheckout: string[] = [];
  for (const file of files) {
    if (forbidden.has(file.path)) skipped.push(file.path);
    else if (file.status === 'A') toRemove.push(file.path);
    else toCheckout.push(file.path);
  }
  for (const path of toRemove) {
    await rm(join(params.dir, path), { force: true });
  }
  if (toCheckout.length) {
    await git(params.dir, ['checkout', base, '--', ...toCheckout]);
  }
  return { ok: true, base, restored: toCheckout, removed: toRemove, skipped };
};
