import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { repo } from '@/db/schema';

/**
 * Resolves a GitHub repoId to its current { owner, repo } slug.
 *
 * The intake/jobs APIs only receive a repoId (the stable cross-system join
 * key — it survives renames and transfers, unlike owner/repo). The slug is
 * still needed to build the clone URL, so we look it up: the local `repo`
 * table first (seeded by previous resolutions), then the GitHub API by id.
 * Callers upsert the resolved slug into `repo`, which is what caches it.
 */
export interface ResolvedRepo {
  owner: string;
  repo: string;
}

export const resolveRepo = async (
  repoId: number
): Promise<ResolvedRepo | null> => {
  const [cached] = await db
    .select({ owner: repo.owner, repo: repo.repo })
    .from(repo)
    .where(eq(repo.repoId, repoId))
    .limit(1);
  if (cached) return cached;

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
