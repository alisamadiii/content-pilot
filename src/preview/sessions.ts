import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { db } from '@/db';
import {
  previewEvent,
  previewMessage,
  previewSession,
  type PreviewSessionStatus,
} from '@/db/schema';
import { getAppDir } from '@/lib/settings';
import {
  discardChanges,
  resetBranchToDefault,
  sanitize,
  syncRepo,
} from '../worker/git';
import { injectAnalyzer } from './analyzer';
import { previewConfig, previewUrlFor } from './config';
import type { BootPlan } from './framework';
import { emitEvent } from './events';
import { registerRoute, unregisterRoute } from './proxy';

type SessionRow = typeof previewSession.$inferSelect;

type LiveSession = {
  id: string;
  repoId: number;
  dir: string;
  /** Where the website's package.json lives — dir itself or a subproject. */
  appDir: string;
  /** How to boot the tagged dev server (framework + config/launcher), or null. */
  boot: BootPlan | null;
  port: number;
  child: ChildProcess;
  restarts: number;
  lastSpawnAt: number;
  // Set during teardown so the exit handler doesn't treat the kill as a crash.
  closing: boolean;
};

const live = new Map<string, LiveSession>();

export const liveSession = (id: string) => live.get(id);
export const liveCount = () => live.size;
export const liveIds = () => [...live.keys()];

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};

const setStatus = async (
  id: string,
  status: PreviewSessionStatus,
  extra: Partial<SessionRow> = {}
) => {
  await db
    .update(previewSession)
    .set({ status, ...extra, updatedAt: new Date() })
    .where(eq(previewSession.id, id));
  await emitEvent(id, 'status', { status, error: extra.error ?? null });
};

// ---------------------------------------------------------------------------
// Port allocation: bind-test each candidate so a zombie process from a crashed
// container never collides with a new session.
// ---------------------------------------------------------------------------

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });

const allocatePort = async () => {
  const used = new Set([...live.values()].map((session) => session.port));
  for (let port = previewConfig.portMin; port <= previewConfig.portMax; port++) {
    if (used.has(port)) continue;
    if (await portFree(port)) return port;
  }
  throw new Error('No free preview ports — too many concurrent sessions.');
};

// ---------------------------------------------------------------------------
// Install + dev server
// ---------------------------------------------------------------------------

const run = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number }
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args[0]} timed out`));
    }, opts.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(sanitize(stderr.trim() || `${cmd} exited ${code}`)));
    });
  });

/**
 * Thrown when the supervisor can't tell which folder the site lives in — a repo
 * whose root has no package.json and no admin-set app folder, or an app folder
 * that points at a folder without one. It's an admin config problem, not a
 * crash: startSession maps it to the `needs_config` status so the hub shows a
 * "ask your admin" panel instead of a scary failure, and the client can retry
 * once the app folder is fixed.
 */
export class AppDirConfigError extends Error {}

// Some client repos keep several projects in one repo (e.g. marketing/ next to
// admin/). We never guess which subfolder is the site — a wrong guess would run
// and even publish the wrong project. The site folder is either the repo root
// (single-app repos, the common case) or an explicit admin-set app folder;
// anything else stops here with a config error the admin must resolve.
const findAppDir = (dir: string, override?: string | null) => {
  if (override) {
    const app = join(dir, override);
    if (!existsSync(join(app, 'package.json'))) {
      throw new AppDirConfigError(
        `The configured app folder "${override}" has no package.json — an admin needs to fix the app folder for this project.`
      );
    }
    return app;
  }
  if (existsSync(join(dir, 'package.json'))) return dir;
  throw new AppDirConfigError(
    'This project keeps its site in a subfolder, so an admin needs to set its app folder before it can be previewed.'
  );
};

// Every client repo is npm now. `npm ci` only works with a package-lock.json
// AND wipes node_modules, so it's reserved for cold dirs that actually have
// one; everything else gets the incremental install.
const INSTALL_HASH_MARKER = join('node_modules', '.cp-install-hash');

const depsHash = (dir: string) => {
  const source = existsSync(join(dir, 'package-lock.json'))
    ? join(dir, 'package-lock.json')
    : join(dir, 'package.json');
  try {
    return createHash('sha256').update(readFileSync(source)).digest('hex');
  } catch {
    return null;
  }
};

const installDeps = async (dir: string) => {
  // Stale tree from before the fleet's pnpm → npm switch — npm can't
  // reconcile a .pnpm layout, so wipe and start clean.
  if (existsSync(join(dir, 'node_modules', '.pnpm'))) {
    await rm(join(dir, 'node_modules'), { recursive: true, force: true });
  }
  const cold = !existsSync(join(dir, 'node_modules'));
  // Warm revive fast-path: deps unchanged since the last successful install →
  // skip npm entirely. This is what makes paused→ready take seconds. The marker
  // carries an install-scheme tag so a change in HOW we install (e.g. adding
  // devDependencies) invalidates clones installed the old way and forces one
  // re-install.
  const hash = depsHash(dir);
  const marker = hash ? `${hash}:incdev` : null;
  if (!cold && marker) {
    try {
      if (readFileSync(join(dir, INSTALL_HASH_MARKER), 'utf8').trim() === marker) {
        return;
      }
    } catch {
      // no marker yet — fall through to install
    }
  }
  const hasNpmLock = existsSync(join(dir, 'package-lock.json'));
  // `--include=dev` is load-bearing: the container runs with NODE_ENV=production
  // (for the Next app), which makes npm OMIT devDependencies by default. Astro
  // integrations (@astrojs/sitemap, @astrojs/react, …) usually live in
  // devDependencies, so without this the client's astro.config fails to import
  // them and the dev server exits at config load.
  await run(
    'npm',
    [
      cold && hasNpmLock ? 'ci' : 'install',
      '--include=dev',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: dir,
      timeoutMs: previewConfig.installTimeoutMs,
    }
  );
  if (marker) {
    await writeFile(join(dir, INSTALL_HASH_MARKER), marker).catch(() => {});
  }
};

/** Host suffix the dev server must accept, derived from PREVIEW_URL_BASE. */
const allowedHostSuffix = () => {
  try {
    const host = new URL(previewUrlFor('x')).hostname;
    return host.replace(/^x\./, '.');
  } catch {
    return '.localhost';
  }
};

const hasDevScript = (dir: string) => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.dev);
  } catch {
    return false;
  }
};

// Per-framework dev-server command. Astro/Vite import a git-invisible wrapper
// via `--config`; Next rides a programmatic server (no --config flag exists).
// `--root .` (Astro) pins the project root to appDir so an alternate `--config`
// in a subfolder doesn't make Astro treat that subfolder as the root.
// `--ignore-lock` (Astro 7+, silently ignored by older versions) forces the dev
// server to run in the foreground: Astro 7 detects agentic environments and
// self-daemonizes — the spawned process exits 0 while a detached daemon serves,
// which the crash handler reads as a crash loop and teardown can never kill.
const devCommand = (
  dir: string,
  port: number,
  boot: BootPlan | null
): { cmd: string; args: string[]; env: Record<string, string> } => {
  const p = String(port);
  const extraEnv: Record<string, string> = { ...(boot?.extraEnv ?? {}) };

  if (boot?.framework === 'astro') {
    const flags = [
      '--config',
      boot.configPath,
      '--root',
      '.',
      '--port',
      p,
      '--host',
      '127.0.0.1',
      '--ignore-lock',
    ];
    const [cmd, args] = hasDevScript(dir)
      ? ['npm', ['run', 'dev', '--', ...flags]]
      : ['npx', ['astro', 'dev', ...flags]];
    return { cmd, args: args as string[], env: extraEnv };
  }

  if (boot?.framework === 'vite') {
    // Run Vite directly with our wrapper config. NOT `npm run dev --`: the
    // client's dev script hardcodes its own --port, which would fight ours.
    return {
      cmd: 'npx',
      args: [
        'vite',
        'dev',
        '--config',
        boot.configPath,
        '--port',
        p,
        '--host',
        '127.0.0.1',
      ],
      env: extraEnv,
    };
  }

  if (boot?.framework === 'next') {
    // Run `next dev` directly, not the client's script (which may add
    // --turbopack and hardcode a port). Webpack is the default and required for
    // our on-disk-config loader to run; turbopack would ignore it.
    return {
      cmd: 'npx',
      args: ['next', 'dev', '--port', p, '--hostname', '127.0.0.1'],
      env: extraEnv,
    };
  }

  // Unrecognized framework — boot plainly with no tagging (legacy fallback).
  const flags = ['--port', p, '--host', '127.0.0.1'];
  const [cmd, args] = hasDevScript(dir)
    ? ['npm', ['run', 'dev', '--', ...flags]]
    : ['npx', ['astro', 'dev', ...flags]];
  return { cmd, args: args as string[], env: extraEnv };
};

const spawnDevServer = (dir: string, port: number, boot: BootPlan | null) => {
  const { cmd, args, env: bootEnv } = devCommand(dir, port, boot);
  // Public scheme/port for the HMR websocket (read by the injected wrapper
  // config) — the browser must dial the proxy's public endpoint, never the
  // dev server's internal port.
  let publicProtocol = 'http';
  let publicPort = '80';
  try {
    const url = new URL(previewUrlFor('x'));
    publicProtocol = url.protocol.replace(':', '');
    publicPort = url.port || (publicProtocol === 'https' ? '443' : '80');
  } catch {
    // keep defaults
  }
  return spawn(cmd, args, {
    cwd: dir,
    env: {
      ...process.env,
      // The container sets NODE_ENV=production for the Next app; a dev server
      // must run in development (astro/vite dev, HMR, and dev-only deps expect
      // it). Also stops plugins from taking prod-only branches during preview.
      NODE_ENV: 'development',
      // Belt and braces for Vite's host check; the proxy already rewrites
      // Host to localhost via changeOrigin.
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: allowedHostSuffix(),
      PREVIEW_PUBLIC_PROTOCOL: publicProtocol,
      PREVIEW_PUBLIC_PORT: publicPort,
      FORCE_COLOR: '0',
      ...bootEnv,
    },
    detached: false,
  });
};

/**
 * Tails a dev server's combined stdout/stderr. Without this, a server that
 * dies at boot only ever reports "exited while starting" — the actual astro/
 * vite error (bad config, missing binding, OOM) is the part that matters.
 */
const captureOutput = (child: ChildProcess) => {
  let tail = '';
  const push = (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-3000);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  return () => tail.trim();
};

const waitForReady = async (port: number, child: ChildProcess) => {
  const deadline = Date.now() + previewConfig.devReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('The preview server exited while starting.');
    }
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      return; // any HTTP response counts — even a 404 means Vite is up
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('The preview server did not start in time.');
};

// The dev server prints the REAL cause (a module/import error, a missing dep)
// BEFORE the stack trace, but the stack is what lands at the very end of the
// output. Surface the first meaningful non-stack error line so the hub shows the
// cause — not the misleading transport frame (e.g. Vite 8's "Cannot send
// non-custom events" that masks a failed import). Falls back to the tail end.
const salientError = (tail: string): string => {
  const lines = tail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('at ')); // drop stack frames
  // Prefer the SPECIFIC cause over a generic wrapper ("Unable to load X" is
  // followed by "Cannot find module Y" — the latter is what we want).
  const causeRe =
    /cannot find module|is not exported|cannot resolve|failed to (load|resolve)|ENOENT|SyntaxError|ReferenceError|TypeError|Error \[/i;
  const wrapperRe = /unable to load|failed to load|could not (load|resolve)/i;
  const cause = lines.find((line) => causeRe.test(line));
  if (cause) return cause.slice(0, 400);
  // Otherwise take the wrapper line PLUS the next meaningful line (often the cause).
  const wi = lines.findIndex((line) => wrapperRe.test(line));
  if (wi !== -1) {
    return [lines[wi], lines[wi + 1]].filter(Boolean).join(' — ').slice(0, 400);
  }
  return tail.slice(-300).slice(0, 400);
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const attachCrashHandler = (session: LiveSession) => {
  session.child.on('exit', () => {
    if (session.closing || !live.has(session.id)) return;
    void (async () => {
      const recent = Date.now() - session.lastSpawnAt < 5 * 60_000;
      if (session.restarts >= 1 && recent) {
        log(`session ${session.id}: dev server crashed twice — failing`);
        await teardownSession(session.id, 'failed', 'The preview server keeps crashing. Please close and start a new session.');
        return;
      }
      log(`session ${session.id}: dev server crashed — restarting`);
      session.restarts += 1;
      await setStatus(session.id, 'restarting');
      try {
        session.child = spawnDevServer(
          session.appDir,
          session.port,
          session.boot
        );
        session.lastSpawnAt = Date.now();
        attachCrashHandler(session);
        await waitForReady(session.port, session.child);
        await setStatus(session.id, 'ready', { pid: session.child.pid ?? null });
      } catch (error) {
        await teardownSession(
          session.id,
          'failed',
          sanitize((error as Error).message)
        );
      }
    })();
  });
};

/** Brings a `starting` row fully up: branch, deps, dev server, proxy route. */
export const startSession = async (row: SessionRow) => {
  if (live.has(row.id)) return;
  log(`session ${row.id}: starting for ${row.owner}/${row.repo}`);
  let bootOutput: () => string = () => '';
  try {
    const dir = await syncRepo({
      repoId: row.repoId,
      owner: row.owner,
      repo: row.repo,
      branch: row.branch,
    });

    const appDir = findAppDir(dir, await getAppDir(row.repoId));
    await setStatus(row.id, 'installing');
    await installDeps(appDir);
    // npm leaves artifacts behind (lockfile updates, a fresh package-lock in
    // repos that lack one). Reset so the tree equals the branch before any
    // edit — otherwise every message's changed-files check would see the
    // artifact, trip the forbidden-path floor, and revert Claude's real edit.
    await discardChanges(dir);

    // Inject the preview-only AI analyzer (stamps data-cms-src per framework,
    // powers click-to-point-the-AI). Git-invisible and never modifies the real
    // config, so it can't leak into a publish.
    const boot = injectAnalyzer(dir, appDir);
    if (boot)
      log(
        `session ${row.id}: analyzer injected (${boot.framework}${
          'configPath' in boot ? `: ${boot.configPath}` : ''
        })`
      );

    const port = await allocatePort();
    const child = spawnDevServer(appDir, port, boot);
    bootOutput = captureOutput(child);
    const session: LiveSession = {
      id: row.id,
      repoId: row.repoId,
      dir,
      appDir,
      boot,
      port,
      child,
      restarts: 0,
      lastSpawnAt: Date.now(),
      closing: false,
    };
    live.set(row.id, session);
    attachCrashHandler(session);

    await waitForReady(port, child);
    registerRoute(row.id, port);
    await setStatus(row.id, 'ready', { port, pid: child.pid ?? null });
    log(`session ${row.id}: ready on :${port}`);
  } catch (error) {
    // The dev server's own output tail is the actual diagnosis (astro/vite
    // error, missing binding, OOM) — "exited while starting" alone is useless.
    const tail = sanitize(bootOutput());
    const message = sanitize((error as Error).message || 'unknown error');
    const needsConfig = error instanceof AppDirConfigError;
    log(
      `session ${row.id}: ${needsConfig ? 'needs config' : 'failed'} — ${message}${
        tail ? `\n--- dev server output ---\n${tail}` : ''
      }`
    );
    const session = live.get(row.id);
    if (session) {
      session.closing = true;
      session.child.kill('SIGKILL');
      live.delete(row.id);
    }
    // A config problem is admin-fixable, not a crash — surface the plain message
    // so the hub can tell the client to ask their admin (and retry after).
    await setStatus(row.id, needsConfig ? 'needs_config' : 'failed', {
      error: needsConfig
        ? message.slice(0, 500)
        : `The preview could not start: ${
            tail ? salientError(tail) : message.slice(0, 300)
          }`,
    });
  }
};

/**
 * Idle TTL hit: kill the dev server and free its port, but keep everything a
 * revive needs — the session row, workspace clone, node_modules, the pushed
 * preview/<id> branch, event rows (SSE replay for a still-open tab), and the
 * claudeSessionId. Reviving is just status → 'starting' + NOTIFY; the normal
 * reconcile launch path does the rest against the warm workspace.
 */
export const pauseSession = async (id: string) => {
  const session = live.get(id);
  if (session) {
    session.closing = true;
    unregisterRoute(id);
    session.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        session.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000).unref();
    live.delete(id);
  }
  await setStatus(id, 'paused', { port: null, pid: null });
  log(`session ${id}: paused (idle)`);
};

/**
 * "Discard": throws away every change from this session and returns the preview
 * to production. Resets preview/<id> to origin/main, wipes the AI context +
 * transcript, and keeps the session live — the dev server HMRs the reverted
 * files, no teardown. Called from reconcile only when the session isn't
 * mid-message (see sessionBusy guard).
 */
export const resetSession = async (row: SessionRow) => {
  const session = live.get(row.id);
  if (!session) return;
  log(`session ${row.id}: resetting to production`);
  await resetBranchToDefault({ dir: session.dir, branch: row.branch });
  // Clear the resumed AI context and the whole transcript (also drops any
  // queued messages, so nothing re-applies on top of the reset).
  await db.delete(previewMessage).where(eq(previewMessage.sessionId, row.id));
  await db
    .update(previewSession)
    .set({
      resetRequestedAt: null,
      claudeSessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(previewSession.id, row.id));
  await emitEvent(row.id, 'reset', {});
  log(`session ${row.id}: reset complete`);
};

export const teardownSession = async (
  id: string,
  status: Extract<PreviewSessionStatus, 'closed' | 'published' | 'expired' | 'failed'>,
  error?: string
) => {
  const session = live.get(id);
  if (session) {
    session.closing = true;
    unregisterRoute(id);
    session.child.kill('SIGTERM');
    setTimeout(() => {
      try {
        session.child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000).unref();
    live.delete(id);
  }
  await setStatus(id, status, {
    error: error ?? null,
    closedAt: new Date(),
    pid: null,
  });
  // The SSE store is only needed while the session lives.
  await db.delete(previewEvent).where(eq(previewEvent.sessionId, id));
  log(`session ${id}: torn down (${status})`);
};
