import { spawn, type ChildProcess } from 'child_process';
import { eq, sql } from 'drizzle-orm';
import { existsSync, readFileSync } from 'fs';
import { rm } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { db } from '@/db';
import { previewEvent, previewSession, type PreviewSessionStatus } from '@/db/schema';
import { getAppDir } from '@/lib/settings';
import { discardChanges, sanitize, syncRepo } from '../worker/git';
import { injectAnalyzer } from './analyzer';
import { previewConfig, previewUrlFor } from './config';
import { emitEvent } from './events';
import { lastActivity, registerRoute, unregisterRoute } from './proxy';

type SessionRow = typeof previewSession.$inferSelect;

type LiveSession = {
  id: string;
  repoId: number;
  dir: string;
  /** Where the website's package.json lives — dir itself or a subproject. */
  appDir: string;
  /** `--config` path (relative to appDir) for the injected analyzer, or null. */
  configArg: string | null;
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
const installDeps = async (dir: string) => {
  // Stale tree from before the fleet's pnpm → npm switch — npm can't
  // reconcile a .pnpm layout, so wipe and start clean.
  if (existsSync(join(dir, 'node_modules', '.pnpm'))) {
    await rm(join(dir, 'node_modules'), { recursive: true, force: true });
  }
  const cold = !existsSync(join(dir, 'node_modules'));
  const hasNpmLock = existsSync(join(dir, 'package-lock.json'));
  await run(
    'npm',
    [cold && hasNpmLock ? 'ci' : 'install', '--no-audit', '--no-fund'],
    {
      cwd: dir,
      timeoutMs: previewConfig.installTimeoutMs,
    }
  );
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

const spawnDevServer = (
  dir: string,
  port: number,
  configArg: string | null
) => {
  // `--root .` pins the project root to appDir so an alternate `--config` in a
  // subfolder doesn't make Astro treat that subfolder as the root.
  // `--ignore-lock` (Astro 7+, silently ignored by older versions) forces the
  // dev server to run in the foreground: Astro 7 detects agentic environments
  // and self-daemonizes — the spawned process exits 0 while a detached daemon
  // serves, which the crash handler reads as a crash loop and the teardown can
  // never kill. ignore-lock disables auto-backgrounding and lock-file checks.
  const flags = [
    ...(configArg ? ['--config', configArg, '--root', '.'] : []),
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    '--ignore-lock',
  ];
  const [cmd, args] = hasDevScript(dir)
    ? ['npm', ['run', 'dev', '--', ...flags]]
    : ['npx', ['astro', 'dev', ...flags]];
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
  return spawn(cmd, args as string[], {
    cwd: dir,
    env: {
      ...process.env,
      // Belt and braces for Vite's host check; the proxy already rewrites
      // Host to localhost via changeOrigin.
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: allowedHostSuffix(),
      PREVIEW_PUBLIC_PROTOCOL: publicProtocol,
      PREVIEW_PUBLIC_PORT: publicPort,
      FORCE_COLOR: '0',
    },
    detached: false,
  });
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
          session.configArg
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

    // Inject the preview-only AI analyzer (replaces cms-bridge for the session,
    // stamps data-cms-src, powers click-to-point-the-AI). Git-invisible and
    // never touches the real astro.config, so it can't leak into a publish.
    const configArg = injectAnalyzer(dir, appDir);
    if (configArg) log(`session ${row.id}: analyzer injected (${configArg})`);

    const port = await allocatePort();
    const child = spawnDevServer(appDir, port, configArg);
    const session: LiveSession = {
      id: row.id,
      repoId: row.repoId,
      dir,
      appDir,
      configArg,
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
    const message = sanitize((error as Error).message || 'unknown error');
    const needsConfig = error instanceof AppDirConfigError;
    log(
      `session ${row.id}: ${needsConfig ? 'needs config' : 'failed'} — ${message}`
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
        : `The preview could not start: ${message.slice(0, 500)}`,
    });
  }
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

/** Flushes proxy activity to the DB so the idle sweep survives restarts. */
export const flushActivity = async () => {
  for (const [id, at] of lastActivity) {
    // GREATEST: the web process also heartbeats lastActivityAt (transcript
    // polling) — never let a stale in-memory proxy timestamp regress it.
    await db
      .update(previewSession)
      .set({
        lastActivityAt: sql`greatest(${previewSession.lastActivityAt}, ${new Date(at)})`,
      })
      .where(eq(previewSession.id, id));
  }
};
