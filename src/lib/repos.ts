import { desc, sql } from 'drizzle-orm';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { db } from '@/db';
import { job, previewSession } from '@/db/schema';
import { config } from '@/worker/config';
import { git } from '@/worker/git';
import { parseRemote } from './resolve-repo';

/**
 * Projects are derived, not stored — there is no `repo` table. A "known repo"
 * is any repoId that has job or preview-session history, plus any clone dir on
 * disk (named by repoId). owner/repo/branch come from the denormalized history
 * rows (free), or from a clone's `origin` remote for disk-only dirs (no API).
 */
export interface KnownRepo {
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
  cloned: boolean;
  jobCount: number;
  lastJobAt: Date | null;
}

const isCloned = (repoId: number) =>
  existsSync(join(config.workspaceDir, String(repoId), '.git'));

export const listKnownRepos = async (): Promise<KnownRepo[]> => {
  const map = new Map<number, KnownRepo>();

  // Per-repo job counts.
  const counts = await db
    .select({
      repoId: job.repoId,
      jobCount: sql<number>`count(*)::int`,
    })
    .from(job)
    .groupBy(job.repoId);
  const countMap = new Map(counts.map((c) => [c.repoId, c.jobCount]));

  // Jobs newest-first → first row per repoId carries the current slug + last-job time.
  const jobRows = await db
    .select({
      repoId: job.repoId,
      owner: job.owner,
      repo: job.repo,
      branch: job.branch,
      createdAt: job.createdAt,
    })
    .from(job)
    .orderBy(desc(job.createdAt));
  for (const row of jobRows) {
    if (map.has(row.repoId)) continue;
    map.set(row.repoId, {
      repoId: row.repoId,
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
      cloned: isCloned(row.repoId),
      jobCount: countMap.get(row.repoId) ?? 0,
      lastJobAt: row.createdAt,
    });
  }

  // Preview-session repoIds without job history.
  const sessions = await db
    .select({
      repoId: previewSession.repoId,
      owner: previewSession.owner,
      repo: previewSession.repo,
      branch: previewSession.branch,
    })
    .from(previewSession)
    .orderBy(desc(previewSession.createdAt));
  for (const row of sessions) {
    if (map.has(row.repoId)) continue;
    map.set(row.repoId, {
      repoId: row.repoId,
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
      cloned: isCloned(row.repoId),
      jobCount: 0,
      lastJobAt: null,
    });
  }

  // Clone dirs with no history — resolve the slug from the on-disk remote.
  let dirs: string[] = [];
  try {
    dirs = readdirSync(config.workspaceDir);
  } catch {
    dirs = [];
  }
  for (const name of dirs) {
    if (!/^\d+$/.test(name)) continue;
    const repoId = Number(name);
    if (map.has(repoId)) continue;
    if (!existsSync(join(config.workspaceDir, name, '.git'))) continue;
    let slug: { owner: string; repo: string } | null = null;
    try {
      slug = parseRemote(
        await git(join(config.workspaceDir, name), ['remote', 'get-url', 'origin'])
      );
    } catch {
      slug = null;
    }
    map.set(repoId, {
      repoId,
      owner: slug?.owner ?? '(unknown)',
      repo: slug?.repo ?? name,
      branch: 'main',
      cloned: true,
      jobCount: 0,
      lastJobAt: null,
    });
  }

  return [...map.values()].sort(
    (a, b) =>
      (b.lastJobAt?.getTime() ?? 0) - (a.lastJobAt?.getTime() ?? 0) ||
      a.repoId - b.repoId
  );
};

/**
 * Workspaces derived strictly from what's on disk: every numeric clone dir in
 * the workspace folder, with its live slug + checked-out branch read from git.
 * Unlike listKnownRepos, this never invents rows from job/session history —
 * every row is a real folder you can configure or delete. Job stats, when they
 * exist, are merged in for display only.
 */
export const listWorkspaces = async (): Promise<KnownRepo[]> => {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(config.workspaceDir);
  } catch {
    dirs = [];
  }

  // Per-repo job stats (count + last-job time) for enrichment only.
  const stats = await db
    .select({
      repoId: job.repoId,
      jobCount: sql<number>`count(*)::int`,
      // Raw sql max() skips drizzle's column parser → comes back a string, not a
      // Date. Coerce below so callers get a real Date (or null).
      lastJobAt: sql<string | null>`max(${job.createdAt})`,
    })
    .from(job)
    .groupBy(job.repoId);
  const statMap = new Map(
    stats.map((s) => [
      s.repoId,
      { jobCount: s.jobCount, lastJobAt: s.lastJobAt ? new Date(s.lastJobAt) : null },
    ])
  );

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

    const stat = statMap.get(repoId);
    rows.push({
      repoId,
      owner: slug?.owner ?? '(unknown)',
      repo: slug?.repo ?? name,
      branch,
      cloned: true,
      jobCount: stat?.jobCount ?? 0,
      lastJobAt: stat?.lastJobAt ?? null,
    });
  }

  return rows.sort(
    (a, b) =>
      (b.lastJobAt?.getTime() ?? 0) - (a.lastJobAt?.getTime() ?? 0) ||
      a.repoId - b.repoId
  );
};

export interface RepoOption {
  repoId: number;
  owner: string;
  repo: string;
}

/** Lightweight repo list for the jobs/webhooks pickers. */
export const listRepoOptions = async (): Promise<RepoOption[]> => {
  const repos = await listKnownRepos();
  return repos
    .map((r) => ({ repoId: r.repoId, owner: r.owner, repo: r.repo }))
    .sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
};
