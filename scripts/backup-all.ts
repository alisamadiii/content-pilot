/**
 * Push every uploaded project's `main` to the GitHub backup org.
 *
 *   pnpm exec tsx scripts/backup-all.ts [--dry-run]
 *
 * Backfills projects imported before backups existed and catches up any whose
 * last push failed. Skips GitHub clones (they have an origin) and anything
 * that isn't a project workspace. Safe to re-run: repos are created once
 * (cp.backupRepo) and pushes are idempotent.
 */
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { isProjectId } from '../src/lib/project-id';
import { backupProject, isBackupConfigured } from '../src/worker/backup';
import { config } from '../src/worker/config';
import { git, hasOrigin } from '../src/worker/git';

const dryRun = process.argv.includes('--dry-run');

const main = async () => {
  if (!isBackupConfigured()) {
    console.error('Set GITHUB_BACKUP_ORG and GITHUB_BACKUP_TOKEN first.');
    process.exit(1);
  }
  let ok = 0;
  let failed = 0;
  for (const entry of await readdir(config.workspaceDir)) {
    const dir = join(config.workspaceDir, entry);
    if (!isProjectId(entry) || !existsSync(join(dir, '.git'))) continue;
    if (await hasOrigin(dir)) continue;
    // The first commit message is "Import <name>"; reuse it for the repo name.
    const first = await git(dir, ['log', '--reverse', '--format=%s', 'main'])
      .then((log) => log.split('\n')[0] ?? '')
      .catch(() => '');
    const name = first.replace(/^Import\s+/, '') || 'site';
    if (dryRun) {
      console.log(`would back up ${entry} (${name})`);
      continue;
    }
    try {
      const sha = await backupProject(entry, name);
      console.log(`ok ${entry} ${sha.slice(0, 7)}`);
      ok++;
    } catch (error) {
      console.error(`FAIL ${entry}: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }
  console.log(`done: ${ok} backed up, ${failed} failed`);
  process.exit(failed ? 1 : 0);
};

void main();
