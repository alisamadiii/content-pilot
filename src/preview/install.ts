import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { sanitize } from '../worker/git';
import { previewConfig } from './config';
import {
  INSTALL_HASH_MARKER,
  installMarker,
  installUpToDate,
  userCodeEnv,
} from './session-boot';

// npm install + one-shot client commands. DB-free so it stays
// unit-testable. Every command runs with the scrubbed userCodeEnv.

export const run = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    // Builds (astro/vite) print their errors on stdout, npm on stderr.
    captureStdout?: boolean;
  }
) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? userCodeEnv(),
    });
    let stderr = '';
    const push = (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    };
    child.stderr?.on('data', push);
    // Always drain stdout — an unread pipe fills and stalls a chatty build.
    if (opts.captureStdout) child.stdout?.on('data', push);
    else child.stdout?.resume();
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
export const installDeps = async (dir: string) => {
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

