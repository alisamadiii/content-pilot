import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { config } from '../worker/config';
import { repoDir } from '../worker/git';
import { findAppDir } from './session-boot';
import { detectFramework } from './framework';
import { previewConfig } from './config';

const execFileAsync = promisify(execFile);

/**
 * Always-on "live site" for uploaded (no-GitHub) projects: the published state
 * (local `main`) is snapshotted into `<WORKSPACE_DIR>/.live/<repoId>/current`
 * and the preview proxy serves that directory statically under the Host label
 * `site-<repoId>`. No per-project process, no registry — the import/publish
 * code writes snapshots, the proxy resolves them from disk per request, so a
 * restart of either process changes nothing.
 *
 * `git archive main` is deliberately the source: it emits exactly the
 * committed tree — no `.git`, no git-excluded analyzer wrappers, and never a
 * mid-session working-tree edit.
 *
 * V1 scope: static projects only (no package.json + index.html). Framework
 * projects get edit preview + local publish, but no 24/7 serve — that would
 * mean one node process per project. A later build-to-dist publish step can
 * feed this same snapshot dir without touching the serving side.
 */

export const liveDir = (repoId: number) =>
  join(config.workspaceDir, '.live', String(repoId));

export const liveServeRoot = (repoId: number) => join(liveDir(repoId), 'current');

export const liveLabel = (repoId: number) => `site-${repoId}`;

/** `site-<repoId>` Host label → repoId, else null. Dash keeps the namespace
 * disjoint from 12-char [a-z0-9] session ids. */
export const repoIdFromLiveLabel = (label: string): number | null => {
  const match = /^site-(\d{1,16})$/.exec(label);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export const liveUrlFor = (repoId: number) =>
  previewConfig.urlBase.replace('{id}', liveLabel(repoId));

/** Whether this workspace gets a live serve at all (static sites only in v1). */
export const isLiveServable = (repoId: number): boolean => {
  try {
    const dir = repoDir(repoId);
    if (!existsSync(dir)) return false;
    return detectFramework(findAppDir(dir)) === 'static';
  } catch {
    return false;
  }
};

/**
 * Re-snapshots local `main` into the serve dir. Atomic for readers: extract
 * into `incoming-<ts>`, rename the old `current` away, rename incoming in.
 * Returns the live URL, or null when the project is not live-servable.
 */
export const refreshLiveSnapshot = async (
  repoId: number
): Promise<string | null> => {
  if (!isLiveServable(repoId)) return null;
  const dir = repoDir(repoId);
  const base = liveDir(repoId);
  const incoming = join(base, `incoming-${Date.now()}`);
  await mkdir(incoming, { recursive: true });
  // git archive writes a tar of the committed tree; tar -x materializes it.
  await execFileAsync(
    '/bin/sh',
    ['-c', `git archive main | tar -x -C "${incoming}"`],
    { cwd: dir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
  );
  const current = join(base, 'current');
  const retired = join(base, `retired-${Date.now()}`);
  if (existsSync(current)) await rename(current, retired);
  await rename(incoming, current);
  // Best-effort cleanup of the retired snapshot and any stragglers from
  // crashed refreshes.
  const entries = await readdir(base).catch(() => [] as string[]);
  for (const name of entries) {
    if (name !== 'current') {
      await rm(join(base, name), { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
  return liveUrlFor(repoId);
};

/** Removes the live serve dir entirely (project delete). */
export const removeLiveSnapshot = async (repoId: number) => {
  await rm(liveDir(repoId), { recursive: true, force: true }).catch(
    () => undefined
  );
};
