import { spawn, type ChildProcess } from 'child_process';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
import { rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { join } from 'path';
import { db } from '@/db';
import {
  previewAttachment,
  previewEvent,
  previewMessage,
  previewSession,
  type PreviewSessionStatus,
} from '@/db/schema';
import { getAppDir } from '@/lib/settings';
import { removeSessionUploads } from '@/lib/uploads';
import { removeGeminiSystemPrompt } from './gemini-system-prompt';
import {
  discardChanges,
  resetBranchToDefault,
  sanitize,
  syncRepo,
} from '../worker/git';
import { injectAnalyzer } from './analyzer';
import { previewConfig } from './config';
import type { BootPlan } from './framework';
import { emitEvent } from './events';
import { registerRoute, unregisterRoute } from './proxy';
import {
  AppDirConfigError,
  allowedHostSuffix,
  devCommand,
  findAppDir,
  INSTALL_HASH_MARKER,
  installMarker,
  installUpToDate,
  publicEndpoint,
  salientError,
} from './session-boot';

export { AppDirConfigError } from './session-boot';

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
  // Warm revive fast-path: deps unchanged since the last successful install →
  // skip npm entirely. This is what makes paused→ready take seconds. The marker
  // carries an install-scheme tag so a change in HOW we install (e.g. adding
  // devDependencies) invalidates clones installed the old way and forces one
  // re-install.
  const marker = installMarker(dir);
  if (!cold && installUpToDate(dir, marker)) return;
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

const spawnDevServer = (dir: string, port: number, boot: BootPlan | null) => {
  const { cmd, args, env: bootEnv } = devCommand(dir, port, boot);
  // Public scheme/port for the HMR websocket (read by the injected wrapper
  // config) — the browser must dial the proxy's public endpoint, never the
  // dev server's internal port.
  const { protocol: publicProtocol, port: publicPort } = publicEndpoint();
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
    .delete(previewAttachment)
    .where(eq(previewAttachment.sessionId, row.id));
  await removeSessionUploads(row.id);
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
  // Uploaded images only matter while the chat lives.
  await db.delete(previewAttachment).where(eq(previewAttachment.sessionId, id));
  await removeSessionUploads(id);
  await removeGeminiSystemPrompt(id);
  log(`session ${id}: torn down (${status})`);
};
