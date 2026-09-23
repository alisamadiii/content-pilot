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

/** Clones the repo if missing, otherwise resets it hard to origin/<branch>. */
export const syncRepo = async (params: {
  repoId: number;
  owner: string;
  repo: string;
  branch: string;
}) => {
  const dir = repoDir(params.repoId);
  const url = `https://github.com/${params.owner}/${params.repo}.git`;

  if (!existsSync(join(dir, '.git'))) {
    await git(config.workspaceDir, ['clone', '--branch', params.branch, url, dir], true);
    return dir;
  }

  await git(dir, ['remote', 'set-url', 'origin', url]);
  await git(dir, ['fetch', 'origin', params.branch], true);
  await git(dir, ['checkout', params.branch]);
  await git(dir, ['reset', '--hard', `origin/${params.branch}`]);
  await git(dir, ['clean', '-fd']);
  return dir;
};

export const changedFiles = async (dir: string) => {
  const output = await git(dir, ['status', '--porcelain']);
  if (!output) {
    return [];
  }
  return output.split('\n').map((line) => line.slice(3).trim().replace(/^"|"$/g, ''));
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
    await git(params.dir, ['push', 'origin', params.branch], true);
  } catch {
    // Remote moved between sync and push — rebase once and retry.
    await git(params.dir, [...identity, 'pull', '--rebase', 'origin', params.branch], true);
    await git(params.dir, ['push', 'origin', params.branch], true);
  }
  return git(params.dir, ['rev-parse', 'HEAD']);
};
