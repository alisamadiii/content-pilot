import { closeSync, existsSync, openSync } from 'fs';
import { cp, mkdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { config } from './config';
import { git, repoDir } from './git';

/**
 * Replace an uploaded project's whole source with a freshly extracted tree
 * (hub "Import" on an existing project). The new tree becomes one commit on
 * `main` on top of the old history, so nothing is lost and the GitHub backup
 * is a fast-forward.
 *
 * Built entirely in `staging` and swapped in with two renames: a failure at
 * any step leaves the original workspace untouched. Everything untracked in
 * the old tree (node_modules, the install marker, analyzer wrapper configs,
 * .astro/, dist/) stays behind with it, so a framework switch (Astro → Vite →
 * static) starts the next session with a clean install and a fresh boot plan.
 */

export const importsRoot = () => join(config.workspaceDir, '.imports');

const lockPath = (projectId: string) =>
  join(importsRoot(), `${projectId}.lock`);

/** True while a replace holds the project (sessions POST refuses to start). */
export const isReplacing = (projectId: string) =>
  existsSync(lockPath(projectId));

/**
 * Exclusive per-project lock (O_EXCL file on the shared workspace volume, so
 * the Next app and the supervisor both see it). Returns a release function,
 * or null when another replace holds it.
 */
export const acquireReplaceLock = async (
  projectId: string
): Promise<(() => Promise<void>) | null> => {
  await mkdir(importsRoot(), { recursive: true });
  const path = lockPath(projectId);
  try {
    closeSync(openSync(path, 'wx'));
  } catch {
    return null;
  }
  return () => rm(path, { force: true });
};

export interface ReplaceParams {
  projectId: string;
  /** Extracted, wrapper-stripped, framework-checked new source. */
  staging: string;
  name: string;
  author: { name: string; email: string } | null;
}

export const replaceWorkspace = async ({
  projectId,
  staging,
  name,
  author,
}: ReplaceParams): Promise<{ sha: string }> => {
  const dir = repoDir(projectId);
  if (!existsSync(join(dir, '.git'))) {
    throw new Error('Workspace missing.');
  }
  if (existsSync(join(staging, '.git'))) {
    // Extraction skips .git entries; this guards direct callers.
    await rm(join(staging, '.git'), { recursive: true, force: true });
  }

  // History + config (cp.backupRepo, info/exclude) come along; the working
  // tree does not.
  await cp(join(dir, '.git'), join(staging, '.git'), {
    recursive: true,
    verbatimSymlinks: true,
  });

  // Whatever branch a session had checked out, the commit lands on main with
  // main's index as the base: add -A then stages every old file's deletion
  // plus the new files, filtered by the NEW project's .gitignore.
  await git(staging, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(staging, ['read-tree', 'refs/heads/main']);
  await git(staging, ['add', '-A']);
  await git(staging, [
    '-c',
    `user.name=${config.gitAuthorName}`,
    '-c',
    `user.email=${config.gitAuthorEmail}`,
    'commit',
    '--allow-empty',
    '-m',
    `Replace source with ${name}`,
    ...(author ? [`--author=${author.name} <${author.email}>`] : []),
  ]);

  // Session branches were cut from the old source; they're meaningless now.
  const branches = await git(staging, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/',
  ]);
  for (const branch of branches.split('\n').map((b) => b.trim())) {
    if (branch && branch !== 'main') {
      await git(staging, ['branch', '-D', branch]);
    }
  }
  const sha = await git(staging, ['rev-parse', 'HEAD']);

  // Two renames on one volume. Between them the dir is briefly absent; the
  // lock keeps sessions from starting in that window.
  const old = join(importsRoot(), `${projectId}-old-${Date.now()}`);
  await rename(dir, old);
  try {
    await rename(staging, dir);
  } catch (error) {
    await rename(old, dir);
    throw error;
  }
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
  return { sha };
};
