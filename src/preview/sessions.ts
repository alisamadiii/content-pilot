import { spawn, type ChildProcess } from 'child_process';
import { eq } from 'drizzle-orm';
import { existsSync } from 'fs';
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
import { getProjectEnv } from '@/lib/settings';
import { removeSessionUploads } from '@/lib/uploads';
import { removeGeminiSystemPrompt } from './gemini-system-prompt';
import {
  discardChanges,
  resetBranchToDefault,
  sanitize,
  syncLocalRepo,
  syncRepo,
} from '../worker/git';
import { injectAnalyzer } from './analyzer';
import { installDeps } from './install';
import { previewConfig } from './config';
import { type BootPlan, checkFramework } from './framework';
import { projectDevEnv, readEnvExample } from './env-example';
import { emitEvent } from './events';
import { registerRoute, unregisterRoute } from './proxy';
import {
  allowedHostSuffix,
  assertSiteRoot,
  devCommand,
  publicEndpoint,
  salientError,
  USER_CODE_ENV_KEYS,
  userCodeEnv,
} from './session-boot';

/**
 * The project isn't a supported static site (no site at the root, Next.js,
 * SSR, unknown stack). Its message is client-facing and shown un-prefixed.
 */
class UnsupportedProjectError extends Error {}

type SessionRow = typeof previewSession.$inferSelect;

type LiveSession = {
  id: string;
  projectId: string | null;
  dir: string;
  /** How to boot the tagged dev server (framework + wrapper config). */
  boot: BootPlan;
  port: number;
  /** The project's env values for this dev server (see loadProjectEnv). */
  projectEnv: Record<string, string>;
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

/**
 * The owner's stored env values the dev server gets: only keys the clone's
 * `.env.example` lists, never one of the base process keys. Re-read on every
 * (re)start so a saved value or an edited `.env.example` applies. Passed via
 * the process env only — writing a `.env` into the clone would get committed
 * by `add -A` and trip the `.env*` guardrails.
 */
const loadProjectEnv = async (projectId: string | null, dir: string) => {
  if (!projectId) return {};
  const keys = readEnvExample(dir).map((entry) => entry.key);
  if (!keys.length) return {};
  return projectDevEnv(keys, await getProjectEnv(projectId), [
    ...USER_CODE_ENV_KEYS,
    'PORT',
    'HOST',
  ]);
};

const spawnDevServer = (
  dir: string,
  port: number,
  boot: BootPlan,
  projectEnv: Record<string, string>
) => {
  const { cmd, args, env: bootEnv } = devCommand(dir, port, boot);
  // Public scheme/port for the HMR websocket (read by the injected wrapper
  // config) — the browser must dial the proxy's public endpoint, never the
  // dev server's internal port.
  const { protocol: publicProtocol, port: publicPort } = publicEndpoint();
  return spawn(cmd, args, {
    cwd: dir,
    env: userCodeEnv({
      // Spread first: every pilot-set key below wins over a project value.
      ...projectEnv,
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
    }),
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
          session.dir,
          session.port,
          session.boot,
          session.projectEnv
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
    // Upload workspaces are local-only git (no remote, nothing to re-clone);
    // GitHub ones sync against origin as always.
    const dir =
      row.source === 'upload'
        ? await syncLocalRepo({ projectId: row.projectId, branch: row.branch })
        : await syncRepo({
            projectId: row.projectId,
            owner: row.owner,
            repo: row.repo,
            branch: row.branch,
          });

    try {
      assertSiteRoot(dir);
    } catch (error) {
      throw new UnsupportedProjectError((error as Error).message);
    }
    // Imports are gated already; this catches projects whose repo changed
    // underneath us (e.g. a GitHub repo later switched to Next.js).
    const check = checkFramework(dir);
    if (!check.ok) throw new UnsupportedProjectError(check.message);
    // Static repos (no package.json) skip the install entirely — nothing to
    // install, and `npm install` in a package-json-less dir would walk UP to a
    // parent package.json and install the wrong thing.
    if (existsSync(join(dir, 'package.json'))) {
      await setStatus(row.id, 'installing');
      await installDeps(dir);
    }
    // npm leaves artifacts behind (lockfile updates, a fresh package-lock in
    // repos that lack one). Reset so the tree equals the branch before any
    // edit — otherwise every message's changed-files check would see the
    // artifact, trip the forbidden-path floor, and revert Claude's real edit.
    await discardChanges(dir);

    // Inject the preview-only AI analyzer (stamps data-cms-src per framework,
    // powers click-to-point-the-AI). Git-invisible and never modifies the real
    // config, so it can't leak into a publish.
    const boot = injectAnalyzer(dir);
    if (!boot) throw new Error('The preview analyzer is missing on the server.');
    log(
      `session ${row.id}: analyzer injected (${boot.framework}: ${boot.configPath})`
    );

    // A fresh boot reads the current env values, so a pending restart request
    // (env saved while paused or still installing) is already satisfied.
    await db
      .update(previewSession)
      .set({ devRestartRequestedAt: null })
      .where(eq(previewSession.id, row.id));
    const projectEnv = await loadProjectEnv(row.projectId, dir);

    const port = await allocatePort();
    const child = spawnDevServer(dir, port, boot, projectEnv);
    bootOutput = captureOutput(child);
    const session: LiveSession = {
      id: row.id,
      projectId: row.projectId,
      dir,
      boot,
      port,
      projectEnv,
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
    const unsupported = error instanceof UnsupportedProjectError;
    log(
      `session ${row.id}: failed — ${message}${
        tail ? `\n--- dev server output ---\n${tail}` : ''
      }`
    );
    const session = live.get(row.id);
    if (session) {
      session.closing = true;
      session.child.kill('SIGKILL');
      live.delete(row.id);
    }
    // An unsupported project isn't a crash — its message is already
    // client-facing, so it goes through un-prefixed.
    await setStatus(row.id, 'failed', {
      error: unsupported
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

/** SIGTERM, SIGKILL after 5s; resolves once the process has exited. */
const stopChild = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });

/**
 * "Restart" (and saved env values): respawns the dev server on the same port
 * with a fresh env, so new project env values apply. Files and chat are left
 * alone. Called from reconcile only when the session is ready, idle and not
 * mid-reset.
 */
export const restartDevServer = async (row: SessionRow) => {
  const session = live.get(row.id);
  if (!session) return;
  log(`session ${row.id}: restarting dev server`);
  // Cleared up front: a request that lands mid-restart sets it again and is
  // picked up next tick.
  await db
    .update(previewSession)
    .set({ devRestartRequestedAt: null, updatedAt: new Date() })
    .where(eq(previewSession.id, row.id));
  await setStatus(row.id, 'restarting');
  // closing = the old child's exit handler must not read this as a crash.
  session.closing = true;
  await stopChild(session.child);
  // Torn down (closed/paused) while the old server was stopping: nothing to do.
  if (live.get(row.id) !== session) return;
  let output: () => string = () => '';
  try {
    session.projectEnv = await loadProjectEnv(session.projectId, session.dir);
    session.child = spawnDevServer(
      session.dir,
      session.port,
      session.boot,
      session.projectEnv
    );
    output = captureOutput(session.child);
    session.closing = false;
    session.restarts = 0;
    session.lastSpawnAt = Date.now();
    attachCrashHandler(session);
    await waitForReady(session.port, session.child);
    await setStatus(row.id, 'ready', { pid: session.child.pid ?? null });
    await emitEvent(row.id, 'restarted', {});
    log(`session ${row.id}: dev server restarted on :${session.port}`);
  } catch (error) {
    const tail = sanitize(output());
    log(
      `session ${row.id}: restart failed — ${sanitize((error as Error).message)}${
        tail ? `\n--- dev server output ---\n${tail}` : ''
      }`
    );
    await teardownSession(
      row.id,
      'failed',
      `The preview could not restart: ${
        tail ? salientError(tail) : sanitize((error as Error).message).slice(0, 300)
      }`
    );
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
  // Uploaded images only matter while the chat lives.
  await db.delete(previewAttachment).where(eq(previewAttachment.sessionId, id));
  await removeSessionUploads(id);
  await removeGeminiSystemPrompt(id);
  log(`session ${id}: torn down (${status})`);
};
