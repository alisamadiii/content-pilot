import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { config } from './config';

const execFileAsync = promisify(execFile);

// PAT is passed per-invocation via an Authorization header, never embedded in
// the remote URL — git error messages echo URLs and job errors reach clients.
const authHeader = () =>
  `Authorization: Basic ${Buffer.from(`x-access-token:${config.githubPat}`).toString('base64')}`;

const gitAuthArgs = () => {
  if (!config.githubPat) {
    return []; // fall back to the system credential helper
  }
  return [
    '-c',
    'credential.helper=',
    '-c',
    `http.https://github.com/.extraHeader=${authHeader()}`,
  ];
};

/** Removes the PAT and auth header from any string before it is stored. */
export const sanitize = (text: string) => {
  const withoutPat = config.githubPat
    ? text.split(config.githubPat).join('[REDACTED]')
    : text;
  return withoutPat.replace(
    /Authorization: Basic [A-Za-z0-9+/=]+/g,
    'Authorization: [REDACTED]'
  );
};

export const git = async (cwd: string, args: string[], withAuth = false) => {
  const fullArgs = withAuth ? [...gitAuthArgs(), ...args] : args;
  try {
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new Error(sanitize(e.stderr || e.message || 'git failed'));
  }
};

export const repoDir = (repoId: number) => join(config.workspaceDir, String(repoId));

/** The repo's default branch (origin/HEAD), falling back to "main". */
const defaultBranch = async (dir: string) => {
  try {
    // Best-effort: make sure origin/HEAD points at the remote's default.
    await git(dir, ['remote', 'set-head', 'origin', '-a'], true).catch(() => '');
    const ref = await git(dir, [
      'symbolic-ref',
      '--short',
      'refs/remotes/origin/HEAD',
    ]);
    return ref.replace(/^origin\//, '').trim() || 'main';
  } catch {
    return 'main';
  }
};

/**
 * Clones the repo if missing, then puts it on `params.branch`:
 *  - if that branch exists on the remote, reset hard to it;
 *  - if it does not, create it fresh from the repo's default branch.
 * Either way the working tree is clean and on the target branch.
 */
export const syncRepo = async (params: {
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
}) => {
  const dir = repoDir(params.repoId);
  const url = `https://github.com/${params.owner}/${params.repo}.git`;

  if (!existsSync(join(dir, '.git'))) {
    // Clone the default branch (always exists); the target is handled below.
    await git(config.workspaceDir, ['clone', url, dir], true);
  } else {
    await git(dir, ['remote', 'set-url', 'origin', url]);
  }

  await git(dir, ['fetch', 'origin', '--prune'], true);

  const remoteHead = await git(
    dir,
    ['ls-remote', '--heads', 'origin', params.branch],
    true
  );

  if (remoteHead.trim()) {
    // Branch exists remotely — check it out and reset to it.
    await git(dir, ['checkout', '-B', params.branch, `origin/${params.branch}`]);
    await git(dir, ['reset', '--hard', `origin/${params.branch}`]);
  } else {
    // New branch — base it on the repo's default branch.
    const base = await defaultBranch(dir);
    await git(dir, ['checkout', '-B', base, `origin/${base}`]);
    await git(dir, ['reset', '--hard', `origin/${base}`]);
    await git(dir, ['checkout', '-B', params.branch]);
  }
  await git(dir, ['clean', '-fd']);
  return dir;
};

export const changedFiles = async (dir: string) => {
  const output = await git(dir, ['status', '--porcelain']);
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => {
    // git() trims stdout, so the FIRST line may have lost its leading status
    // space (' M _site.json' → 'M _site.json') — a fixed slice(3) then eats
    // the path's first character. Strip the 1–2 char status code explicitly.
    const path = line
      .replace(/^[ MADRCU?!]{1,2}\s+/, '')
      .trim()
      .replace(/^"|"$/g, '');
    // Renames list as 'old -> new'; the new path is what exists on disk.
    const arrow = path.indexOf(' -> ');
    return arrow === -1 ? path : path.slice(arrow + 4);
  });
};

export const discardChanges = async (dir: string) => {
  await git(dir, ['reset', '--hard']);
  await git(dir, ['clean', '-fd']);
};

export const commitAndPush = async (params: {
  dir: string;
  branch: string;
  message: string;
}) => {
  const identity = [
    '-c',
    `user.name=${config.gitAuthorName}`,
    '-c',
    `user.email=${config.gitAuthorEmail}`,
  ];
  await git(params.dir, ['add', '-A']);
  await git(params.dir, [...identity, 'commit', '-m', params.message]);
  try {
    await git(params.dir, ['push', '-u', 'origin', params.branch], true);
  } catch (error) {
    // Only a branch that already exists remotely can have moved under us —
    // rebase once and retry. For a brand-new branch, rethrow the real error.
    const remoteHead = await git(
      params.dir,
      ['ls-remote', '--heads', 'origin', params.branch],
      true
    );
    if (!remoteHead.trim()) throw error;
    await git(params.dir, [...identity, 'pull', '--rebase', 'origin', params.branch], true);
    await git(params.dir, ['push', '-u', 'origin', params.branch], true);
  }
  return git(params.dir, ['rev-parse', 'HEAD']);
};
