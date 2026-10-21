import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { previewUrlFor } from './config';
import type { BootPlan } from './framework';

// Pure boot-time decisions behind sessions.ts (site root, install cache key,
// dev-server command, public endpoint, error salience). DB-free so they can be
// unit-tested without a DATABASE_URL.

// Sites always live at the repo root. A root qualifies with a package.json
// (framework repos) OR an index.html (plain static repos with no toolchain at
// all); anything else can't be previewed or published.
export const NO_SITE_MESSAGE =
  "We couldn't find a site at the root of this project. Content Pilot hosts static sites: Astro, Vite, or plain HTML.";

export const assertSiteRoot = (dir: string): void => {
  if (
    existsSync(join(dir, 'package.json')) ||
    existsSync(join(dir, 'index.html'))
  ) {
    return;
  }
  throw new Error(NO_SITE_MESSAGE);
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

// Process env passed to CLIENT code (npm install scripts, dev servers, builds).
// Allow-list, never a deny-list: the pilot's own env carries DATABASE_URL, the
// GitHub App private key, auth secrets and AI keys, and any postinstall script
// or config file in a client repo could read whatever we hand it.
const USER_CODE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'NODE_OPTIONS',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
];

export const userCodeEnv = (
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  const env: Record<string, string> = {};
  for (const key of USER_CODE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  // Cast: Next's type augmentation makes NODE_ENV a required ProcessEnv key;
  // callers that need it (dev, build) pass it in `extra`.
  return { ...env, ...extra } as NodeJS.ProcessEnv;
};

// Per-framework dev-server command. Every framework boots a git-invisible
// wrapper via `--config` (see analyzer.ts).
// `--root .` (Astro) pins the project root to the clone dir so the `--config`
// wrapper living in ai-analyzer/ doesn't make Astro treat that folder as root.
// `--ignore-lock` (Astro 7+, silently ignored by older versions) forces the dev
// server to run in the foreground: Astro 7 detects agentic environments and
// self-daemonizes — the spawned process exits 0 while a detached daemon serves,
// which the crash handler reads as a crash loop and teardown can never kill.
export const devCommand = (
  dir: string,
  port: number,
  boot: BootPlan
): { cmd: string; args: string[]; env: Record<string, string> } => {
  const p = String(port);
  const extraEnv: Record<string, string> = { ...(boot.extraEnv ?? {}) };

  if (boot.framework === 'astro') {
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

  if (boot.framework === 'vite') {
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

  // static: plain HTML/CSS/JS repo served by the pilot's OWN Vite against the
  // clone dir (spawnDevServer sets cwd=dir, Vite's root defaults to cwd).
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
