import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { netlifyDeploy, type NetlifyDeployStatus } from '@/db/schema';
import { defaultBranch, git, repoDir } from '../worker/git';
import { BuildError, withSourceZip } from './build';
import { buildOnNetlify, NetlifyError, waitForNetlifyDeploy } from './netlify';

/**
 * In-process deploy queue of the API server. The hub's publish POSTs a job
 * with the project's Netlify token; the token stays in this module's memory
 * only (never in the DB), so a restart fails the in-flight jobs and the client
 * redeploys from the hub's Netlify page. One upload at a time across all
 * projects (the build itself runs on Netlify and is followed in the
 * background); a newer job for the same project supersedes a queued older one.
 */

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [deploy] ${message}`);
};

export type NetlifyDeployRow = typeof netlifyDeploy.$inferSelect;

const RUNNING: NetlifyDeployStatus[] = ['queued', 'building', 'uploading'];

const tokens = new Map<number, string>();
let draining = false;
let recovered = false;

const setStatus = (
  id: number,
  values: Partial<typeof netlifyDeploy.$inferInsert>
) => db.update(netlifyDeploy).set(values).where(eq(netlifyDeploy.id, id));

/** Rows left running by a previous process lost their token: fail them. */
const recoverInterrupted = async () => {
  if (recovered) return;
  recovered = true;
  await db
    .update(netlifyDeploy)
    .set({
      status: 'error',
      error: 'The deploy was interrupted. Redeploy to try again.',
      finishedAt: new Date(),
    })
    .where(inArray(netlifyDeploy.status, RUNNING));
};

export const enqueueDeploy = async (params: {
  projectId: string;
  siteId: string;
  token: string;
}): Promise<NetlifyDeployRow> => {
  await recoverInterrupted();
  // Supersede this project's still-queued jobs (not one already building).
  const stale = await db
    .update(netlifyDeploy)
    .set({ status: 'skipped', finishedAt: new Date() })
    .where(
      and(
        eq(netlifyDeploy.projectId, params.projectId),
        eq(netlifyDeploy.status, 'queued')
      )
    )
    .returning({ id: netlifyDeploy.id });
  for (const row of stale) tokens.delete(row.id);

  const [row] = await db
    .insert(netlifyDeploy)
    .values({ projectId: params.projectId, siteId: params.siteId })
    .returning();
  tokens.set(row.id, params.token);
  void drain();
  return row;
};

export const latestDeploy = async (projectId: string) => {
  const [row] = await db
    .select()
    .from(netlifyDeploy)
    .where(eq(netlifyDeploy.projectId, projectId))
    .orderBy(desc(netlifyDeploy.id))
    .limit(1);
  return row ?? null;
};

const failMessage = (error: unknown) =>
  error instanceof BuildError || error instanceof NetlifyError
    ? error.message
    : 'The deploy failed unexpectedly. Try again.';

/** Follows Netlify's build of an uploaded job until it's live or failed. */
const followBuild = async (row: NetlifyDeployRow, token: string, deployId: string) => {
  try {
    await waitForNetlifyDeploy(token, deployId);
    await setStatus(row.id, { status: 'ready', finishedAt: new Date() });
    log(`deployed ${row.projectId} → ${deployId}`);
  } catch (error) {
    log(`build failed ${row.projectId}: ${error instanceof Error ? error.message : error}`);
    await setStatus(row.id, { status: 'error', error: failMessage(error), finishedAt: new Date() });
  }
};

// Uploads the source; Netlify builds it with the site's env vars. The build is
// followed without blocking the queue, so one slow build doesn't hold up
// other projects' publishes.
const runJob = async (row: NetlifyDeployRow, token: string) => {
  const dir = repoDir(row.projectId);
  const branch = await defaultBranch(dir);
  const sha = (await git(dir, ['rev-parse', `refs/heads/${branch}`])).trim();
  await setStatus(row.id, { status: 'uploading', sha });
  log(`upload ${row.projectId} @ ${sha.slice(0, 7)}`);

  const deployId = await withSourceZip({ projectId: row.projectId, sha }, (zip) =>
    buildOnNetlify({
      zip,
      siteId: row.siteId,
      token,
      title: `Published from the Client Hub (${sha.slice(0, 7)})`,
    })
  );
  await setStatus(row.id, { status: 'building', netlifyDeployId: deployId });
  void followBuild(row, token, deployId);
};

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const ids = [...tokens.keys()].sort((a, b) => a - b);
      if (ids.length === 0) return;
      const id = ids[0];
      const token = tokens.get(id)!;
      tokens.delete(id);
      const [row] = await db
        .select()
        .from(netlifyDeploy)
        .where(eq(netlifyDeploy.id, id))
        .limit(1);
      if (!row || row.status !== 'queued') continue;
      try {
        await runJob(row, token);
      } catch (error) {
        log(`failed ${row.projectId}: ${error instanceof Error ? error.message : error}`);
        await setStatus(id, { status: 'error', error: failMessage(error), finishedAt: new Date() });
      }
    }
  } finally {
    draining = false;
  }
};
