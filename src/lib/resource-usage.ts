import { execFile } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { statfs } from 'fs/promises';
import { totalmem, freemem } from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Disk + memory measurements for the dashboard `urls` page. The whole pilot
 * (proxy, preview dev servers, builds) is one container, so Coolify only sees
 * totals; per-project numbers come from the workspace dirs and the dev-server
 * process trees. Results are cached for a minute so a reload never re-walks
 * node_modules.
 */

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
};

/** Bytes used by a directory (`du -sk`); 0 when missing or unreadable. */
export const dirSizeBytes = (path: string): Promise<number> =>
  cached(`du:${path}`, async () => {
    try {
      const { stdout } = await execFileAsync('du', ['-sk', path], {
        timeout: 10_000,
      });
      const kb = Number(stdout.trim().split(/\s+/)[0]);
      return Number.isFinite(kb) ? kb * 1024 : 0;
    } catch {
      return 0;
    }
  });

export type ProcRow = { pid: number; ppid: number; rssBytes: number };

/** Parses `ps -A -o pid=,ppid=,rss=` output (rss in KiB). */
export const parsePsOutput = (stdout: string): ProcRow[] =>
  stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length >= 3 && cols.every(Number.isFinite))
    .map(([pid, ppid, rss]) => ({ pid, ppid, rssBytes: rss * 1024 }));

/** Summed RSS of `pid` and every descendant; null when `pid` isn't running. */
export const treeRss = (rows: ProcRow[], pid: number): number | null => {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(pid)) return null;
  const children = new Map<number, number[]>();
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  }
  let total = 0;
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    total += byPid.get(current)?.rssBytes ?? 0;
    stack.push(...(children.get(current) ?? []));
  }
  return total;
};

// Linux (the container): read /proc directly — busybox `ps -o` support varies.
const procSnapshot = (): ProcRow[] => {
  const pageSize = 4096;
  const rows: ProcRow[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // stat: "pid (comm) state ppid ..." — comm may contain spaces/parens.
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const rssPages = Number(
        readFileSync(`/proc/${name}/statm`, 'utf8').split(' ')[1]
      );
      rows.push({ pid: Number(name), ppid, rssBytes: rssPages * pageSize });
    } catch {
      // Process exited mid-walk.
    }
  }
  return rows;
};

/** One snapshot of every process (pid, ppid, rss), cached briefly. */
export const processSnapshot = (): Promise<ProcRow[]> =>
  cached('ps', async () => {
    if (process.platform === 'linux') return procSnapshot();
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['-A', '-o', 'pid=,ppid=,rss='],
        { timeout: 5_000, maxBuffer: 10 * 1024 * 1024 }
      );
      return parsePsOutput(stdout);
    } catch {
      return [];
    }
  });

const readNumber = (path: string): number | null => {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * Memory of the pilot container: the cgroup v2 limit/usage when present (the
 * container's own numbers), else the machine's (local dev).
 */
export const memoryOverview = () => {
  const used = readNumber('/sys/fs/cgroup/memory.current');
  const limit = readNumber('/sys/fs/cgroup/memory.max'); // "max" → null
  if (used !== null) {
    return { usedBytes: used, totalBytes: limit ?? totalmem(), scope: 'container' };
  }
  return {
    usedBytes: totalmem() - freemem(),
    totalBytes: totalmem(),
    scope: 'machine',
  };
};

/** Free + total bytes on the volume holding `path`. */
export const diskOverview = async (path: string) => {
  try {
    const stats = await statfs(path);
    return {
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    };
  } catch {
    return null;
  }
};

export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};
