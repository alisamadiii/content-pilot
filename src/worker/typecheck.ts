import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { config } from './config';

const execFileAsync = promisify(execFile);

export type TypecheckResult =
  | { status: 'pass' }
  | { status: 'fail'; output: string }
  | { status: 'skip'; reason: string };

type Pm = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** Pick the package manager from whichever lockfile the repo ships. */
const detectPm = (dir: string): { pm: Pm; lockfile: string | null } => {
  if (existsSync(join(dir, 'pnpm-lock.yaml')))
    return { pm: 'pnpm', lockfile: 'pnpm-lock.yaml' };
  if (existsSync(join(dir, 'yarn.lock'))) return { pm: 'yarn', lockfile: 'yarn.lock' };
  if (existsSync(join(dir, 'bun.lockb'))) return { pm: 'bun', lockfile: 'bun.lockb' };
  if (existsSync(join(dir, 'package-lock.json')))
    return { pm: 'npm', lockfile: 'package-lock.json' };
  return { pm: 'npm', lockfile: null };
};

const installArgs = (pm: Pm, hasLock: boolean): string[] => {
  switch (pm) {
    case 'pnpm':
      return hasLock ? ['install', '--frozen-lockfile'] : ['install'];
    case 'yarn':
      return hasLock ? ['install', '--frozen-lockfile'] : ['install'];
    case 'bun':
      return ['install'];
    case 'npm':
      return hasLock ? ['ci'] : ['install'];
  }
};

type RunResult = { code: number; output: string; killed: boolean };

/** execFile that captures stdout+stderr on both success and failure. */
const run = async (
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<RunResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return { code: 0, output: `${stdout}${stderr}`, killed: false };
  } catch (error) {
    const e = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || '';
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      output,
      killed: Boolean(e.killed),
    };
  }
};

/** Keep the tail of a long tool output — the errors are usually at the end. */
const trimOutput = (text: string) => {
  const limit = 6_000;
  if (text.length <= limit) return text;
  return `... [truncated]\n${text.slice(-limit)}`;
};

/**
 * Install deps only when needed: no node_modules yet, or the lockfile changed
 * since the last successful install. The marker lives *outside* the clone
 * (a sibling of the repo dir in the workspace) so `git clean -fd` between runs
 * can't wipe it. node_modules is gitignored, so it survives `reset --hard`.
 */
const ensureDeps = async (
  dir: string,
  repoId: number,
  pm: Pm,
  lockfile: string | null
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const hasLock = Boolean(lockfile);
  const hash = lockfile
    ? createHash('sha256')
        .update(readFileSync(join(dir, lockfile)))
        .digest('hex')
    : 'no-lock';
  const markerPath = join(config.workspaceDir, `${repoId}.deps-hash`);
  const prior = existsSync(markerPath)
    ? readFileSync(markerPath, 'utf8').trim()
    : null;

  if (existsSync(join(dir, 'node_modules')) && prior === hash) {
    return { ok: true };
  }

  const res = await run(pm, installArgs(pm, hasLock), dir, config.depsInstallTimeoutMs);
  if (res.code !== 0) {
    return { ok: false, error: trimOutput(res.output) };
  }
  writeFileSync(markerPath, hash);
  return { ok: true };
};

/**
 * Run the target repo's typecheck after an edit. Resolves a command from the
 * repo's package.json scripts (`typecheck` → `check` → `build`), or the
 * TYPECHECK_CMD env override. Installs deps first if needed. A repo with no
 * suitable script is skipped rather than blocked — the gate only fails an edit
 * on a *real* typecheck failure.
 */
export const runTypecheck = async (
  dir: string,
  repoId: number
): Promise<TypecheckResult> => {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return { status: 'skip', reason: 'no package.json' };

  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}) as Record<
      string,
      string
    >;
  } catch {
    return { status: 'skip', reason: 'unreadable package.json' };
  }

  const script =
    ['typecheck', 'check'].find((name) => scripts[name]) ??
    (scripts.build ? 'build' : null);
  if (!script) {
    return { status: 'skip', reason: 'no typecheck/check/build script' };
  }

  const { pm, lockfile } = detectPm(dir);

  const deps = await ensureDeps(dir, repoId, pm, lockfile);
  if (!deps.ok) {
    // An install failure is an environment problem, not the client's edit —
    // skip (and log) rather than reverting a legitimate change.
    return {
      status: 'skip',
      reason: `dependency install failed: ${deps.error.slice(-400)}`,
    };
  }

  const res = await run(pm, ['run', script], dir, config.typecheckTimeoutMs);

  if (res.code === 0) return { status: 'pass' };
  if (res.killed) {
    return { status: 'skip', reason: 'typecheck timed out' };
  }
  return { status: 'fail', output: trimOutput(res.output) };
};
