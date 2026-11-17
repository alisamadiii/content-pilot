import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { git, gitAuthArgs, hasOrigin, repoDir, sanitize } from './git';

/**
 * GitHub backup for uploaded (no-GitHub) projects. Their workspace is the only
 * copy of the source, so on publish and replace the hub names a repo in
 * GITHUB_BACKUP_ORG and the local `main` is force-pushed there. The hub owns
 * which repo (it creates and links them); pilot only pushes. The workspace
 * stays the source of truth: the push goes to an explicit URL, never an
 * `origin` remote (hasOrigin/baseRef would flip the project into GitHub mode).
 *
 * State lives in the clone's own git config, no DB column:
 *  - cp.backupRepo   repo name in the org (last push target)
 *  - cp.backupSha    last pushed main sha
 *  - cp.backupError  last failure, cleared on success
 * Failures never reach the caller; the next push catches everything up.
 */

export const isBackupConfigured = () =>
  !!(config.githubBackupOrg && config.githubBackupToken);

/** A plain repo name in the org (no owner, no path, no URL tricks). */
export const isBackupRepoName = (repo: string) =>
  /^[A-Za-z0-9._-]{1,100}$/.test(repo) && repo !== '.' && repo !== '..';

export interface BackupDeps {
  /** Push target for org/repo (tests point it at a local bare repo). */
  remoteFor?: (org: string, repo: string) => string;
}

const defaultRemote = (org: string, repo: string) =>
  `https://github.com/${org}/${repo}.git`;

const readConfig = async (dir: string, key: string) => {
  try {
    return (await git(dir, ['config', '--get', key])) || null;
  } catch {
    return null; // exit 1 = unset
  }
};

const writeConfig = (dir: string, key: string, value: string) =>
  git(dir, ['config', key, value]);

const clearConfig = (dir: string, key: string) =>
  git(dir, ['config', '--unset', key]).catch(() => '');

export interface BackupState {
  repo: string;
  url: string;
  sha: string | null;
  error: string | null;
}

/** What the clone knows about its backup; null when it was never pushed. */
export const backupState = async (dir: string): Promise<BackupState | null> => {
  const repo = await readConfig(dir, 'cp.backupRepo');
  if (!repo) return null;
  return {
    repo,
    url: `https://github.com/${config.githubBackupOrg}/${repo}`,
    sha: await readConfig(dir, 'cp.backupSha'),
    error: await readConfig(dir, 'cp.backupError'),
  };
};

/** Push the clone's `main` to the given org repo. Throws on failure. */
export const backupProject = async (
  projectId: string,
  repo: string,
  deps: BackupDeps = {}
): Promise<string> => {
  if (!isBackupRepoName(repo)) {
    throw new Error('Invalid backup repo name.');
  }
  const dir = repoDir(projectId);
  if (!existsSync(join(dir, '.git'))) {
    throw new Error('Workspace missing.');
  }
  if (await hasOrigin(dir)) {
    throw new Error('GitHub projects are not backed up.');
  }
  await writeConfig(dir, 'cp.backupRepo', repo);
  const sha = await git(dir, ['rev-parse', 'refs/heads/main']);
  const url = (deps.remoteFor ?? defaultRemote)(config.githubBackupOrg, repo);
  try {
    await git(dir, [
      ...gitAuthArgs(config.githubBackupToken),
      'push',
      '--force',
      '--quiet',
      url,
      'refs/heads/main:refs/heads/main',
    ]);
  } catch (error) {
    throw new Error(sanitize(error instanceof Error ? error.message : 'push failed'));
  }
  await writeConfig(dir, 'cp.backupSha', sha);
  await clearConfig(dir, 'cp.backupError');
  return sha;
};

// One push at a time per project; later requests chain behind the running one.
const chains = new Map<string, Promise<void>>();

/**
 * Fire-and-forget backup. Never throws and never blocks the caller; a failure
 * is logged and written to cp.backupError for the hub to show.
 */
export const queueBackup = (
  projectId: string,
  repo: string,
  deps: BackupDeps = {}
): Promise<void> => {
  if (!isBackupConfigured()) return Promise.resolve();
  const previous = chains.get(projectId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await backupProject(projectId, repo, deps);
    } catch (error) {
      const message = sanitize(
        error instanceof Error ? error.message : 'backup failed'
      ).slice(0, 500);
      console.error(`[backup] ${projectId}: ${message}`);
      try {
        await writeConfig(repoDir(projectId), 'cp.backupError', message);
      } catch {
        // Workspace gone (deleted mid-push); nothing to record.
      }
    }
  });
  chains.set(projectId, next);
  void next.finally(() => {
    if (chains.get(projectId) === next) chains.delete(projectId);
  });
  return next;
};
