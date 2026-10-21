import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, readdir, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { config } from '../worker/config';
import { repoDir } from '../worker/git';
import { checkFramework, findAstroConfig } from './framework';
import { installDeps, run } from './install';
import { previewConfig } from './config';
import {
  installMarker,
  installUpToDate,
  salientError,
  userCodeEnv,
} from './session-boot';

const execFileAsync = promisify(execFile);

/**
 * The always-on "live site" of every project: the published commit, built to
 * static files, served from `<WORKSPACE_DIR>/.live/<repoId>/current` by the
 * preview proxy under the Host label `site-<repoId>` (and any custom domain).
 * No per-project process, no registry — builds write the dir, the proxy
 * resolves it from disk per request, so a restart of either changes nothing.
 *
 * buildLiveSite is the only writer. It works on `git archive <sha>` of the
 * exact published commit — no `.git`, no git-excluded analyzer wrappers, never
 * a mid-session working-tree edit — in a scratch dir beside `current`:
 *  - static: the archive IS the site (no build).
 *  - astro/vite: install deps, build, and serve ONLY the output `dist/`.
 * The new output is swapped into `current` atomically; any failure leaves the
 * previous live site untouched.
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

/** Whether a build has ever gone live for this project. */
export const hasLiveSite = (repoId: number) =>
  existsSync(liveServeRoot(repoId));

/** A failed live build: `message` is client-facing, `log` the output tail. */
export class BuildError extends Error {
  constructor(
    message: string,
    readonly log = ''
  ) {
    super(message);
  }
}

/**
 * Moves `srcDir` in as the new `current`. Atomic for readers: rename into
 * `incoming-<ts>`, rename the old `current` away, rename incoming in. Then
 * clears everything else under the live dir (the retired site, the build
 * scratch dir, stragglers from crashed builds).
 */
export const swapLive = async (repoId: number, srcDir: string) => {
  const base = liveDir(repoId);
  const incoming = join(base, `incoming-${Date.now()}`);
  await rename(srcDir, incoming);
  const current = join(base, 'current');
  const retired = join(base, `retired-${Date.now()}`);
  if (existsSync(current)) await rename(current, retired);
  await rename(incoming, current);
  const entries = await readdir(base).catch(() => [] as string[]);
  for (const name of entries) {
    if (name !== 'current') {
      await rm(join(base, name), { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
};

// Astro build wrapper: the client's real config, minus any adapter, forced to
// static output in ./dist. An adapter (cloudflare, node, vercel…) would emit a
// server bundle instead of a plain folder of files.
const astroBuildWrapper = (configName: string | null) => `${
  configName
    ? `import base from ${JSON.stringify(`./${configName}`)};`
    : 'const base = {};'
}
const { adapter: _adapter, ...rest } = base;
export default { ...rest, output: 'static', outDir: './dist' };
`;

const ASTRO_BUILD_CONFIG = 'cp-build.astro.config.mjs';

const hasScript = (dir: string, name: string) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return Boolean(pkg.scripts?.[name]);
  } catch {
    return false;
  }
};

/**
 * Deps for the build dir. Fast path: the preview workspace already has a
 * node_modules installed from the same lockfile — hard-link it (`cp -al`, same
 * volume, near-instant). Build caches are dropped from the copy so a build
 * never rewrites the workspace's files through a shared inode. Otherwise (or
 * where cp -al isn't available) a normal install.
 */
const prepareDeps = async (buildDir: string, workspace: string) => {
  const marker = installMarker(buildDir);
  if (marker && installUpToDate(workspace, marker)) {
    try {
      await execFileAsync('cp', [
        '-al',
        join(workspace, 'node_modules'),
        join(buildDir, 'node_modules'),
      ]);
      for (const cache of ['.vite', '.astro', '.cache']) {
        await rm(join(buildDir, 'node_modules', cache), {
          recursive: true,
          force: true,
        });
      }
      return;
    } catch {
      await rm(join(buildDir, 'node_modules'), { recursive: true, force: true });
    }
  }
  await installDeps(buildDir);
};

/** The build command for a framework project, run with cwd = the build root. */
export const buildCommand = (
  framework: 'astro' | 'vite',
  dir: string
): [string, string[]] => {
  if (framework === 'astro') {
    return [
      'npx',
      ['astro', 'build', '--config', ASTRO_BUILD_CONFIG, '--root', '.'],
    ];
  }
  // Vite projects keep their own build script (often `tsc -b && vite build`).
  return hasScript(dir, 'build')
    ? ['npm', ['run', 'build']]
    : ['npx', ['vite', 'build']];
};

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * Builds the published commit and swaps it live. Throws BuildError (previous
 * live site untouched) on any failure.
 */
export const buildLiveSite = async (params: {
  repoId: number;
  sha: string;
}) => {
  const { repoId, sha } = params;
  if (!SHA_RE.test(sha)) throw new BuildError('Invalid commit to publish.');
  const workspace = repoDir(repoId);
  if (!existsSync(join(workspace, '.git'))) {
    throw new BuildError("This project's files are missing from the server.");
  }
  const root = join(liveDir(repoId), `build-${Date.now()}`);
  await mkdir(root, { recursive: true });
  try {
    await execFileAsync(
      '/bin/sh',
      ['-c', `git archive "${sha}" | tar -x -C "${root}"`],
      { cwd: workspace, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
    );
    const check = checkFramework(root);
    if (!check.ok) throw new BuildError(check.message);

    let out = root;
    if (check.framework !== 'static') {
      await prepareDeps(root, workspace);
      if (check.framework === 'astro') {
        await writeFile(
          join(root, ASTRO_BUILD_CONFIG),
          astroBuildWrapper(findAstroConfig(root))
        );
      }
      const [cmd, args] = buildCommand(check.framework, root);
      await run(cmd, args, {
        cwd: root,
        timeoutMs: previewConfig.buildTimeoutMs,
        env: userCodeEnv({ NODE_ENV: 'production', FORCE_COLOR: '0', CI: '1' }),
        captureStdout: true,
      });
      out = join(root, 'dist');
      if (existsSync(join(out, 'server'))) {
        throw new BuildError(
          'The build produced a server bundle. Content Pilot hosts static sites only.'
        );
      }
      if (!existsSync(join(out, 'index.html'))) {
        throw new BuildError(
          'The build finished but dist/index.html is missing. Make sure the site builds to dist/.'
        );
      }
    }
    await swapLive(repoId, out);
  } catch (error) {
    if (error instanceof BuildError) throw error;
    const output = error instanceof Error ? error.message : String(error);
    throw new BuildError(
      `The build failed: ${salientError(output)}`,
      output.slice(-4000)
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Removes the live serve dir entirely (project delete). */
export const removeLiveSnapshot = async (repoId: number) => {
  await rm(liveDir(repoId), { recursive: true, force: true }).catch(
    () => undefined
  );
};
