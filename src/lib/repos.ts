import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { config } from '@/worker/config';
import { git } from '@/worker/git';
import { parseRemote } from './resolve-repo';

/**
 * A workspace is a repo clone on disk (a numeric dir named by repoId). There is
 * no `repo` table — owner/repo/branch are read live from the clone's git remote
 * and checked-out HEAD.
 */
export interface KnownRepo {
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
  cloned: boolean;
}

/**
 * Workspaces derived strictly from what's on disk: every numeric clone dir in
 * the workspace folder, with its live slug + checked-out branch read from git.
 * Every row is a real folder you can configure or delete.
 */
export const listWorkspaces = async (): Promise<KnownRepo[]> => {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(config.workspaceDir);
  } catch {
    dirs = [];
  }

  const rows: KnownRepo[] = [];
  for (const name of dirs) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(config.workspaceDir, name);
    if (!existsSync(join(dir, '.git'))) continue;
    const repoId = Number(name);

    let slug: { owner: string; repo: string } | null = null;
    try {
      slug = parseRemote(await git(dir, ['remote', 'get-url', 'origin']));
    } catch {
      slug = null;
    }

    let branch = 'main';
    try {
      branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'main';
    } catch {
      branch = 'main';
    }

    rows.push({
      repoId,
      owner: slug?.owner ?? '(unknown)',
      repo: slug?.repo ?? name,
      branch,
      cloned: true,
    });
  }

  return rows.sort((a, b) => a.repoId - b.repoId);
};
