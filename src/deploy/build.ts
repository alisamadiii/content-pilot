import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { config } from '../worker/config';
import { repoDir } from '../worker/git';
import { checkFramework, type Framework } from '../preview/framework';
import { salientError } from '../preview/session-boot';

const execFileAsync = promisify(execFile);

/**
 * Packs a commit of an upload project as a source zip for Netlify's Build API:
 * Netlify installs and builds it itself, so the site's Netlify env vars (secret
 * ones included, which the API never returns) and adapters apply exactly as in
 * a Git-connected build. Works on `git archive <sha>` of the exact commit,
 * never the mid-session working tree, so .gitignore'd files (node_modules,
 * .env, dist) are never sent.
 */

/** A failed packing step: `message` is client-facing, `log` the output tail. */
export class BuildError extends Error {
  constructor(
    message: string,
    readonly log = ''
  ) {
    super(message);
  }
}

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
 * Build config for a repo without its own netlify.toml. API-only sites have no
 * build settings and Netlify ignores PATCHed ones, so without this Netlify
 * publishes the raw source.
 */
export const defaultNetlifyToml = (framework: Framework, dir: string): string => {
  if (framework === 'static') return '[build]\n  publish = "."\n';
  const command = hasScript(dir, 'build')
    ? 'npm run build'
    : framework === 'astro'
      ? 'npx astro build'
      : 'npx vite build';
  return `[build]\n  command = "${command}"\n  publish = "dist"\n`;
};

const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/** Scratch root for one check, under the workspace volume. */
const scratchRoot = (projectId: string) =>
  join(config.workspaceDir, '.deploys', `${projectId}-${Date.now()}`);

/**
 * Zips `sha` (plus a default netlify.toml when the repo has none) and hands it
 * to `use`. The commit is unpacked to a scratch dir only to detect the
 * framework; it's removed afterwards either way. Throws BuildError.
 */
export const withSourceZip = async <T>(
  params: { projectId: string; sha: string },
  use: (zip: Buffer) => Promise<T>
): Promise<T> => {
  const { projectId, sha } = params;
  if (!SHA_RE.test(sha)) throw new BuildError('Invalid commit to deploy.');
  const workspace = repoDir(projectId);
  if (!existsSync(join(workspace, '.git'))) {
    throw new BuildError("This project's files are missing from the server.");
  }
  const root = scratchRoot(projectId);
  await mkdir(root, { recursive: true });
  try {
    let zip: Buffer;
    try {
      await execFileAsync(
        '/bin/sh',
        ['-c', `git archive "${sha}" | tar -x -C "${root}"`],
        { cwd: workspace, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }
      );
      const check = checkFramework(root);
      if (!check.ok) throw new BuildError(check.message);

      const extra = existsSync(join(root, 'netlify.toml'))
        ? []
        : [`--add-virtual-file=netlify.toml:${defaultNetlifyToml(check.framework, root)}`];
      const { stdout } = await execFileAsync(
        'git',
        ['archive', '--format=zip', ...extra, sha],
        { cwd: workspace, timeout: 120_000, maxBuffer: MAX_ZIP_BYTES, encoding: 'buffer' }
      );
      zip = stdout;
    } catch (error) {
      if (error instanceof BuildError) throw error;
      const output = error instanceof Error ? error.message : String(error);
      throw new BuildError(
        `Packing the site failed: ${salientError(output)}`,
        output.slice(-4000)
      );
    }
    return await use(zip);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
};
