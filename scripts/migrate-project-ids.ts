/**
 * One-time cutover from the numeric repoId to the hub's projectId (uuid).
 *
 *   pnpm exec tsx scripts/migrate-project-ids.ts <map.json> [--dry-run]
 *
 * map.json = { "<repoId>": "<projectId>", ... }, exported from the hub
 * (packages/drizzle/scripts/export-project-map.ts). For every entry:
 *  - renames the workspace dir <WORKSPACE_DIR>/<repoId> -> <projectId>
 *  - sets preview_session.project_id on rows with that repo_id
 *  - re-keys the ai_provider:<repoId> / gemini_tier:<repoId> settings rows
 * Idempotent: an already-renamed dir, filled project_id or moved key is
 * skipped, so it can be re-run safely. Run with no live preview sessions.
 */
import { existsSync, readFileSync } from 'fs';
import { rename } from 'fs/promises';
import { join } from 'path';
import { and, eq, isNull } from 'drizzle-orm';
import { client, db } from '../src/db';
import { appSetting, previewSession } from '../src/db/schema';
import { isProjectId } from '../src/lib/project-id';
import { geminiTierKey, providerKey } from '../src/lib/settings-rules';
import { config } from '../src/worker/config';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mapPath = args.find((a) => !a.startsWith('--'));
if (!mapPath) {
  console.error(
    'usage: tsx scripts/migrate-project-ids.ts <map.json> [--dry-run]'
  );
  process.exit(2);
}

const raw = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
  string,
  string
>;
const entries = Object.entries(raw).filter(([repoId, projectId]) => {
  const ok = /^\d+$/.test(repoId) && isProjectId(projectId);
  if (!ok) console.warn(`[skip] invalid map entry ${repoId} -> ${projectId}`);
  return ok;
});

const log = (msg: string) =>
  console.log(`${dryRun ? '[dry-run] ' : ''}${msg}`);

const main = async () => {
  let dirs = 0;
  let sessions = 0;
  let settings = 0;

  for (const [repoIdText, projectId] of entries) {
    const repoId = Number(repoIdText);

    // 1. Workspace dir.
    const from = join(config.workspaceDir, repoIdText);
    const to = join(config.workspaceDir, projectId);
    if (existsSync(from)) {
      if (existsSync(to)) {
        console.warn(`[skip] both ${from} and ${to} exist; resolve by hand`);
      } else {
        log(`rename ${from} -> ${to}`);
        if (!dryRun) await rename(from, to);
        dirs += 1;
      }
    }

    // 2. Session rows still on the legacy key.
    const rows = await db
      .select({ id: previewSession.id })
      .from(previewSession)
      .where(
        and(eq(previewSession.repoId, repoId), isNull(previewSession.projectId))
      );
    if (rows.length) {
      log(`preview_session repo_id=${repoId}: ${rows.length} row(s) -> ${projectId}`);
      if (!dryRun) {
        await db
          .update(previewSession)
          .set({ projectId })
          .where(
            and(
              eq(previewSession.repoId, repoId),
              isNull(previewSession.projectId)
            )
          );
      }
      sessions += rows.length;
    }

    // 3. Per-project settings keys.
    for (const prefix of ['ai_provider', 'gemini_tier'] as const) {
      const oldKey = `${prefix}:${repoIdText}`;
      const newKey =
        prefix === 'ai_provider' ? providerKey(projectId) : geminiTierKey(projectId);
      const [row] = await db
        .select()
        .from(appSetting)
        .where(eq(appSetting.key, oldKey))
        .limit(1);
      if (!row) continue;
      log(`setting ${oldKey} -> ${newKey} (${row.value})`);
      if (!dryRun) {
        await db
          .insert(appSetting)
          .values({ key: newKey, value: row.value })
          .onConflictDoNothing();
        await db.delete(appSetting).where(eq(appSetting.key, oldKey));
      }
      settings += 1;
    }
  }

  log(
    `done: ${dirs} dir(s), ${sessions} session row(s), ${settings} setting(s) across ${entries.length} map entries`
  );
  const [{ count }] = await client<{ count: number }[]>`
    select count(*)::int as count from preview_session where project_id is null`;
  if (count > 0) {
    console.warn(
      `${count} preview_session row(s) still have no project_id (repos missing from the map); they can't be resumed.`
    );
  }
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client.end());
