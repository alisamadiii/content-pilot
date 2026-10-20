import { existsSync } from 'fs';
import { join } from 'path';
import { git, parseRemote, repoDir } from '@/worker/git';
import { resolveRepoIdViaApp } from '@/worker/github-app';

// Canonical implementation lives in worker/git (sanitize/auth need it there);
// re-exported here so existing importers keep working.
export { parseRemote } from '@/worker/git';

/**
 * Resolves a GitHub repoId to its current { owner, repo } slug.
 *
 * The intake/jobs/sessions APIs only receive a repoId (the stable cross-system
 * join key — it survives renames/transfers, unlike owner/repo). The slug is
 * still needed to build the clone URL. Resolution order, cheapest first:
 *   1. process-lifetime in-memory cache (seeded by the hub's owner/repo hint),
 *   2. the on-disk clone's `origin` remote (no network) when it exists,
 *   3. enumerating the GitHub App's installations by repo id.
 * (There is no `repo` DB table anymore — projects are derived from the
 * workspace + job/session history; see src/lib/repos.ts.)
 */
export interface ResolvedRepo {
  owner: string;
  repo: string;
}

const cache = new Map<number, ResolvedRepo>();

/**
 * Seed the cache with a slug the caller already knows (the hub passes
 * owner/repo on session create) — skips any network resolution and lets the
 * GitHub App path work without a PAT (app JWTs can't call /repositories/:id).
 */
export const seedRepo = (repoId: number, resolved: ResolvedRepo) => {
  if (resolved.owner && resolved.repo) cache.set(repoId, resolved);
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

export const resolveRepo = async (
  repoId: number
): Promise<ResolvedRepo | null> => {
  const hit = cache.get(repoId);
  if (hit) return hit;
  const resolved =
    (await fromClone(repoId)) ?? (await resolveRepoIdViaApp(repoId));
  if (resolved) cache.set(repoId, resolved);
  return resolved;
};
