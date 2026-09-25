import { existsSync } from 'fs';
import { join } from 'path';
import { git, repoDir } from '@/worker/git';

/**
 * Resolves a GitHub repoId to its current { owner, repo } slug.
 *
 * The intake/jobs/sessions APIs only receive a repoId (the stable cross-system
 * join key — it survives renames/transfers, unlike owner/repo). The slug is
 * still needed to build the clone URL. Resolution order, cheapest first:
 *   1. process-lifetime in-memory cache,
 *   2. the on-disk clone's `origin` remote (no network) when it exists,
 *   3. the GitHub API by id.
 * (There is no `repo` DB table anymore — projects are derived from the
 * workspace + job/session history; see src/lib/repos.ts.)
 */
export interface ResolvedRepo {
  owner: string;
  repo: string;
}

const cache = new Map<number, ResolvedRepo>();

/** Parse owner/repo from a GitHub remote URL (https or ssh form). */
export const parseRemote = (url: string): ResolvedRepo | null => {
  const match = url.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
};

const fromClone = async (repoId: number): Promise<ResolvedRepo | null> => {
  const dir = repoDir(repoId);
  if (!existsSync(join(dir, '.git'))) return null;
  try {
    return parseRemote(await git(dir, ['remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
};

const fromGitHub = async (repoId: number): Promise<ResolvedRepo | null> => {
  const pat = process.env.GITHUB_PAT || '';
  const response = await fetch(`https://api.github.com/repositories/${repoId}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(pat ? { Authorization: `Bearer ${pat}` } : {}),
    },
  }).catch(() => null);
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as {
    full_name?: string;
  } | null;
  const [owner, name] = (data?.full_name || '').split('/');
  if (!owner || !name) return null;
  return { owner, repo: name };
};

export const resolveRepo = async (
  repoId: number
): Promise<ResolvedRepo | null> => {
  const hit = cache.get(repoId);
  if (hit) return hit;
  const resolved = (await fromClone(repoId)) ?? (await fromGitHub(repoId));
  if (resolved) cache.set(repoId, resolved);
  return resolved;
};
