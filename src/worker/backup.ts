import { existsSync } from 'fs';
import { join } from 'path';
import { config } from './config';
import { git, gitAuthArgs, hasOrigin, repoDir, sanitize } from './git';

/**
 * GitHub backup for uploaded (no-GitHub) projects. Their workspace is the only
 * copy of the source, so after every import, publish and replace the local
 * `main` is force-pushed to a private repo in GITHUB_BACKUP_ORG. The workspace
 * stays the source of truth: the push goes to an explicit URL, never an
 * `origin` remote (hasOrigin/baseRef would flip the project into GitHub mode).
 *
 * State lives in the clone's own git config, no DB column:
 *  - cp.backupRepo   repo name in the org (set on first push)
 *  - cp.backupSha    last pushed main sha
 *  - cp.backupError  last failure, cleared on success
 * Failures never reach the caller; the next push catches everything up.
 */

const API = 'https://api.github.com';

export const isBackupConfigured = () =>
  !!(config.githubBackupOrg && config.githubBackupToken);

export interface BackupDeps {
  /** GitHub REST transport (tests inject a fake). */
  api?: typeof fetch;
  /** Push target for org/repo (tests point it at a local bare repo). */
  remoteFor?: (org: string, repo: string) => string;
}

const defaultRemote = (org: string, repo: string) =>
  `https://github.com/${org}/${repo}.git`;

const ghHeaders = () => ({
  Authorization: `Bearer ${config.githubBackupToken}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

/** Repo-safe slug + the project id prefix: `acme-plumbing-1a2b3c4d`. */
export const backupRepoName = (nameHint: string, projectId: string) => {
  const slug = nameHint
    .toLowerCase()
    .replace(/\.zip$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'site'}-${projectId.slice(0, 8)}`;
};

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

/**
 * The org repo for this clone, created on first use. The repo description is
 * the project id, so a retry after a crash between "created" and "saved to
 * config" adopts its own repo instead of making a duplicate.
 */
export const ensureBackupRepo = async (
  dir: string,
  projectId: string,
  nameHint: string,
  deps: BackupDeps = {}
): Promise<string> => {
  const saved = await readConfig(dir, 'cp.backupRepo');
  if (saved) return saved;

  const api = deps.api ?? fetch;
  const org = config.githubBackupOrg;
  const base = backupRepoName(nameHint, projectId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = attempt ? `${base}-${attempt + 1}` : base;
    const res = await api(`${API}/orgs/${org}/repos`, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({
        name,
        private: true,
        description: projectId,
        auto_init: false,
        has_issues: false,
        has_projects: false,
        has_wiki: false,
      }),
    });
    if (res.ok) {
      await writeConfig(dir, 'cp.backupRepo', name);
      return name;
    }
    if (res.status !== 422) {
      throw new Error(`GitHub repo create failed (${res.status}): ${await res.text()}`);
    }
    // 422 = name taken. Ours (same project id) → adopt; anyone else's → next.
    const existing = await api(`${API}/repos/${org}/${name}`, {
      headers: ghHeaders(),
    });
    if (existing.ok) {
      const body = (await existing.json()) as { description?: string | null };
      if (body.description === projectId) {
        await writeConfig(dir, 'cp.backupRepo', name);
        return name;
      }
    }
  }
  throw new Error('Could not find a free repo name in the backup org.');
};

/** Push the clone's `main` to its org repo. Throws on failure. */
export const backupProject = async (
  projectId: string,
  nameHint: string,
  deps: BackupDeps = {}
): Promise<string> => {
  const dir = repoDir(projectId);
  if (!existsSync(join(dir, '.git'))) {
    throw new Error('Workspace missing.');
  }
  if (await hasOrigin(dir)) {
    throw new Error('GitHub projects are not backed up.');
  }
  const repo = await ensureBackupRepo(dir, projectId, nameHint, deps);
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
  nameHint: string,
  deps: BackupDeps = {}
): Promise<void> => {
  if (!isBackupConfigured()) return Promise.resolve();
  const previous = chains.get(projectId) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      await backupProject(projectId, nameHint, deps);
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

/** Archive the org repo when the hub deletes the project. Best effort. */
export const archiveBackupRepo = async (
  dir: string,
  deps: BackupDeps = {}
): Promise<boolean> => {
  if (!isBackupConfigured()) return false;
  const repo = await readConfig(dir, 'cp.backupRepo');
  if (!repo) return false;
  try {
    const res = await (deps.api ?? fetch)(
      `${API}/repos/${config.githubBackupOrg}/${repo}`,
      {
        method: 'PATCH',
        headers: ghHeaders(),
        body: JSON.stringify({ archived: true }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    return res.ok;
  } catch (error) {
    console.error(`[backup] archive ${repo} failed`, error);
    return false;
  }
};
