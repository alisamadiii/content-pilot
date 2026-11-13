import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { config } from '../worker/config';
import { repoDir } from '../worker/git';
import { checkFramework, findAstroConfig } from '../preview/framework';
import { installDeps, run } from '../preview/install';
import { previewConfig } from '../preview/config';
import {
  installMarker,
  installUpToDate,
  salientError,
  userCodeEnv,
} from '../preview/session-boot';

const execFileAsync = promisify(execFile);

/**
 * Builds a commit of an upload project to a plain folder of static files for
 * the Netlify deploy (revived from the old live-hosting build, 87bfd69). Works
 * on `git archive <sha>` of the exact commit — never the mid-session working
 * tree — in a scratch dir:
 *  - static: the archive IS the site (no build).
 *  - astro/vite: install deps, build, and deploy ONLY `dist/`.
 */

/** A failed build: `message` is client-facing, `log` the output tail. */
export class BuildError extends Error {
  constructor(
    message: string,
    readonly log = ''
  ) {
    super(message);
  }
}

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

/** Scratch root for one build, under the workspace volume (cp -al needs it). */
const buildRoot = (projectId: string) =>
  join(config.workspaceDir, '.deploys', `${projectId}-${Date.now()}`);

/**
 * Builds `sha` and hands the output dir to `use`; the scratch dir is removed
 * afterwards either way. Throws BuildError on any failure.
 */
export const withBuiltSite = async <T>(
  params: { projectId: string; sha: string },
  use: (outDir: string) => Promise<T>
): Promise<T> => {
  const { projectId, sha } = params;
  if (!SHA_RE.test(sha)) throw new BuildError('Invalid commit to deploy.');
  const workspace = repoDir(projectId);
  if (!existsSync(join(workspace, '.git'))) {
    throw new BuildError("This project's files are missing from the server.");
  }
  const root = buildRoot(projectId);
  await mkdir(root, { recursive: true });
  try {
    let out = root;
    try {
      await execFileAsync(
        '/bin/sh',
        ['-c', `git archive "${sha}" | tar -x -C "${root}"`],
        { cwd: workspace, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
      const check = checkFramework(root);
      if (!check.ok) throw new BuildError(check.message);

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
            'The build produced a server bundle. Only static sites can be deployed.'
          );
        }
        if (!existsSync(join(out, 'index.html'))) {
          throw new BuildError(
            'The build finished but dist/index.html is missing. Make sure the site builds to dist/.'
          );
        }
      }
    } catch (error) {
      if (error instanceof BuildError) throw error;
      const output = error instanceof Error ? error.message : String(error);
      throw new BuildError(
        `The build failed: ${salientError(output)}`,
        output.slice(-4000)
      );
    }
    return await use(out);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
};
