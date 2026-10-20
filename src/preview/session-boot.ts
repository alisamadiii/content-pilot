import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { previewUrlFor } from './config';
import type { BootPlan } from './framework';

// Pure boot-time decisions behind sessions.ts (app folder, install cache key,
// dev-server command, public endpoint, error salience). DB-free so they can be
// unit-tested without a DATABASE_URL.

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
// anything else stops here with a config error the admin must resolve. A folder
// qualifies with a package.json (framework repos) OR an index.html (plain
// static repos with no toolchain at all).
const isSiteDir = (dir: string) =>
  existsSync(join(dir, 'package.json')) || existsSync(join(dir, 'index.html'));

export const findAppDir = (dir: string, override?: string | null) => {
  if (override) {
    const app = join(dir, override);
    if (!isSiteDir(app)) {
      throw new AppDirConfigError(
        `The configured app folder "${override}" has no package.json or index.html — an admin needs to fix the app folder for this project.`
      );
    }
    return app;
  }
  if (isSiteDir(dir)) return dir;
  throw new AppDirConfigError(
    'No package.json or index.html at the repo root — if the site lives in a subfolder, an admin needs to set its app folder before it can be previewed.'
  );
};

export const INSTALL_HASH_MARKER = join('node_modules', '.cp-install-hash');

/**
 * Install-scheme tag baked into the marker: changing HOW we install (e.g.
 * adding devDependencies) invalidates clones installed the old way.
 */
export const INSTALL_SCHEME = 'incdev';

/** Hash of the lockfile (preferred) or package.json — the install cache key. */
export const depsHash = (dir: string) => {
  const source = existsSync(join(dir, 'package-lock.json'))
    ? join(dir, 'package-lock.json')
    : join(dir, 'package.json');
  try {
    return createHash('sha256').update(readFileSync(source)).digest('hex');
  } catch {
    return null;
  }
};

/** Marker value written after a successful install; null when nothing to hash. */
export const installMarker = (dir: string) => {
  const hash = depsHash(dir);
  return hash ? `${hash}:${INSTALL_SCHEME}` : null;
};

/** True when a warm node_modules matches the current deps — npm can be skipped. */
export const installUpToDate = (dir: string, marker: string | null) => {
  if (!marker) return false;
  if (!existsSync(join(dir, 'node_modules'))) return false;
  try {
    return readFileSync(join(dir, INSTALL_HASH_MARKER), 'utf8').trim() === marker;
  } catch {
    return false;
  }
};

/** Host suffix the dev server must accept, derived from PREVIEW_URL_BASE. */
export const allowedHostSuffix = () => {
  try {
    const host = new URL(previewUrlFor('x')).hostname;
    return host.replace(/^x\./, '.');
  } catch {
    return '.localhost';
  }
};

/**
 * Public scheme/port for the HMR websocket (read by the injected wrapper
 * config) — the browser must dial the proxy's public endpoint, never the dev
 * server's internal port.
 */
export const publicEndpoint = () => {
  let protocol = 'http';
  let port = '80';
  try {
    const url = new URL(previewUrlFor('x'));
    protocol = url.protocol.replace(':', '');
    port = url.port || (protocol === 'https' ? '443' : '80');
  } catch {
    // keep defaults
  }
  return { protocol, port };
};

/**
 * Vite's CLI bin resolved from the PILOT's own install (cwd is the content-pilot
 * repo root, /app in the container). Static clones have no node_modules, so
 * `npx vite` with cwd=clone can never resolve — the spawn needs this absolute
 * path, run with the pilot's own node (process.execPath).
 */
export const pilotViteBin = () => {
  // vite's exports map hides ./bin/vite.js from resolve(), so locate the
  // package root via its (exported) package.json and join the bin path.
  const pkg = createRequire(join(process.cwd(), 'package.json')).resolve(
    'vite/package.json'
  );
  return join(pkg, '..', 'bin', 'vite.js');
};

export const hasDevScript = (dir: string) => {
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
export const devCommand = (
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

  if (boot?.framework === 'static') {
    // Plain HTML/CSS/JS repo: serve it with the pilot's OWN Vite against the
    // clone dir (spawnDevServer sets cwd=appDir, Vite's root defaults to cwd).
    // No install ever runs in the clone, so the server is up in seconds.
    return {
      cmd: process.execPath,
      args: [
        pilotViteBin(),
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

// The dev server prints the REAL cause (a module/import error, a missing dep)
// BEFORE the stack trace, but the stack is what lands at the very end of the
// output. Surface the first meaningful non-stack error line so the hub shows the
// cause — not the misleading transport frame (e.g. Vite 8's "Cannot send
// non-custom events" that masks a failed import). Falls back to the tail end.
export const salientError = (tail: string): string => {
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
