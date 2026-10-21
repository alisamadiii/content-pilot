import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { client, db } from '@/db';
import { liveBuild } from '@/db/schema';
import { sanitize } from '../worker/git';
import { BuildError, buildLiveSite } from './live-serve';

/**
 * Live-site build queue. The API (publish, import) only writes intent — a
 * `queued` row + NOTIFY cp_build — and the preview supervisor, which owns every
 * long-running child process, drains it here: one build at a time across all
 * projects, newest commit per project wins (older queued rows are `skipped`).
 */

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [build] ${message}`);
};

export type LiveBuildRow = typeof liveBuild.$inferSelect;

/** Queues a build of `sha` for the live site. Called from API routes. */
export const enqueueLiveBuild = async (repoId: number, sha: string) => {
  const [row] = await db
    .insert(liveBuild)
    .values({ repoId, sha })
    .returning({ id: liveBuild.id, status: liveBuild.status });
  try {
    await client.notify('cp_build', String(repoId));
  } catch {
    // The supervisor also drains on an interval.
  }
  return row;
};

/** Latest build for a project (any status), or null. */
export const latestLiveBuild = async (repoId: number) => {
  const [row] = await db
    .select()
    .from(liveBuild)
    .where(eq(liveBuild.repoId, repoId))
    .orderBy(desc(liveBuild.id))
    .limit(1);
  return row ?? null;
};

export const removeLiveBuilds = async (repoId: number) => {
  await db.delete(liveBuild).where(eq(liveBuild.repoId, repoId));
};

/** A crash mid-build leaves `building` rows behind — run them again. */
export const requeueInterruptedBuilds = async () => {
  await db
    .update(liveBuild)
    .set({ status: 'queued', startedAt: null })
    .where(eq(liveBuild.status, 'building'));
};

let draining = false;

/** Builds every queued project, one at a time. Safe to call repeatedly. */
export const drainLiveBuilds = async () => {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const [next] = await db
        .select()
        .from(liveBuild)
        .where(eq(liveBuild.status, 'queued'))
        .orderBy(asc(liveBuild.id))
        .limit(1);
      if (!next) return;
      // Coalesce: only the newest queued commit of this project is built.
      const [newest] = await db
        .select()
        .from(liveBuild)
        .where(
          and(eq(liveBuild.repoId, next.repoId), eq(liveBuild.status, 'queued'))
        )
        .orderBy(desc(liveBuild.id))
        .limit(1);
      await db
        .update(liveBuild)
        .set({ status: 'skipped', finishedAt: new Date() })
        .where(
          and(
            eq(liveBuild.repoId, next.repoId),
            eq(liveBuild.status, 'queued'),
            lt(liveBuild.id, newest.id)
          )
        );
      await runBuild(newest);
    }
  } finally {
    draining = false;
  }
};

const runBuild = async (row: LiveBuildRow) => {
  log(`repo ${row.repoId}: building ${row.sha.slice(0, 7)} (#${row.id})`);
  await db
    .update(liveBuild)
    .set({ status: 'building', startedAt: new Date() })
    .where(eq(liveBuild.id, row.id));
  const started = Date.now();
  try {
    await buildLiveSite({ repoId: row.repoId, sha: row.sha });
    await db
      .update(liveBuild)
      .set({ status: 'ready', error: null, finishedAt: new Date() })
      .where(eq(liveBuild.id, row.id));
    log(`repo ${row.repoId}: live in ${Date.now() - started}ms (#${row.id})`);
  } catch (error) {
    const message =
      error instanceof BuildError
        ? error.message
        : `The build failed: ${(error as Error).message}`;
    const output = error instanceof BuildError ? error.log : '';
    await db
      .update(liveBuild)
      .set({
        status: 'failed',
        error: sanitize(message).slice(0, 500),
        log: sanitize(output).slice(-4000) || null,
        finishedAt: new Date(),
      })
      .where(eq(liveBuild.id, row.id));
    log(`repo ${row.repoId}: build failed (#${row.id}) — ${message}`);
  }
};
