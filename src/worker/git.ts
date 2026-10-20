import { execFile } from 'child_process';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { config } from './config';
import {
  bustTokenValue,
  githubAppSecrets,
  installationTokenFor,
} from './github-app';

const execFileAsync = promisify(execFile);

// Tokens are passed per-invocation via an Authorization header, never embedded
// in the remote URL — git error messages echo URLs and job errors reach clients.
export const gitAuthArgs = (token: string) => {
  if (!token) {
    return []; // fall back to the system credential helper
  }
  return [
    '-c',
    'credential.helper=',
    '-c',
    `http.https://github.com/.extraHeader=Authorization: Basic ${Buffer.from(
      `x-access-token:${token}`
    ).toString('base64')}`,
  ];
};

/** Parse owner/repo from a GitHub remote URL (https or ssh form). */
export const parseRemote = (
  url: string
): { owner: string; repo: string } | null => {
  const match = url.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
};

/**
 * Removes every credential (every minted installation token and auth headers)
 * from any string before it is stored.
 */
export const sanitize = (text: string) => {
  let out = text;
  for (const secret of githubAppSecrets()) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out.replace(
    /Authorization: Basic [A-Za-z0-9+/=]+/g,
    'Authorization: [REDACTED]'
  );
};

/**
 * Lazily resolves the token for an authed git op: installation token when the
 * GitHub App covers the repo, else empty → the system credential helper
 * (local dev). A provider, not a value, so a mid-session 401 can bust + re-mint.
 */
export type GitAuth = () => Promise<string>;

/** Auth for a repo known by slug (clone — the dir may not exist yet). */
export const authForRepo = (owner: string, repo: string): GitAuth =>
  async () => (await installationTokenFor(owner, repo)) ?? '';

/** Auth for an existing clone — owner/repo come from its origin remote. */
export const authFor = (dir: string): GitAuth => async () => {
  try {
    const remote = parseRemote(await git(dir, ['remote', 'get-url', 'origin']));
    if (remote) {
      const token = await installationTokenFor(remote.owner, remote.repo);
      if (token) return token;
    }
  } catch {
    // Local/odd remotes (tests, dev) — fall through to the credential helper.
  }
  return '';
};

const isAuthFailure = (raw: string) =>
  /authentication failed|401|403|could not read username|permission.*denied|denied to/i.test(
    raw
  );

export const git = async (
  cwd: string,
  args: string[],
  auth?: GitAuth
): Promise<string> => {
  const run = async (token: string) => {
    const { stdout } = await execFileAsync(
      'git',
      [...gitAuthArgs(token), ...args],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    return stdout.trim();
  };
  const token = auth ? await auth() : '';
  try {
    return await run(token);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    const raw = e.stderr || e.message || 'git failed';
    // An installation token can be revoked/expired between cache write and
    // use — bust it and retry once with a fresh mint. Credential-helper
    // failures (empty token) are real and never retried.
    if (auth && token && isAuthFailure(raw) && bustTokenValue(token)) {
      const fresh = await auth();
      if (fresh && fresh !== token) {
        try {
          return await run(fresh);
        } catch (retryError) {
          const r = retryError as { stderr?: string; message?: string };
          throw new Error(sanitize(r.stderr || r.message || 'git failed'));
        }
      }
    }
    throw new Error(sanitize(raw));
  }
};

export const repoDir = (repoId: number) => join(config.workspaceDir, String(repoId));

/**
 * Makes `pattern` git-invisible for this clone via `.git/info/exclude` (never
 * the client's committed .gitignore). Excluded paths survive `clean -fd` and
 * never reach `add -A`; used for the preview analyzer wrappers and the chat
 * upload placements manifest.
 */
export const ensureGitExclude = (dir: string, pattern: string) => {
  const excludePath = join(dir, '.git', 'info', 'exclude');
  try {
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, 'utf8')
      : '';
    if (current.split('\n').some((line) => line.trim() === pattern)) return;
    const prefix = !current || current.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort — the client's committed .gitignore is the primary guard.
  }
};

/** The repo's default branch (origin/HEAD), falling back to "main". */
export const defaultBranch = async (dir: string) => {
  try {
    // Best-effort: make sure origin/HEAD points at the remote's default.
    await git(dir, ['remote', 'set-head', 'origin', '-a'], authFor(dir)).catch(
      () => ''
    );
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
  const auth = authForRepo(params.owner, params.repo);

  if (!existsSync(join(dir, '.git'))) {
    // Clone the default branch (always exists); the target is handled below.
    await git(config.workspaceDir, ['clone', url, dir], auth);
  } else {
    await git(dir, ['remote', 'set-url', 'origin', url]);
  }

  await git(dir, ['fetch', 'origin', '--prune'], auth);

  const remoteHead = await git(
    dir,
    ['ls-remote', '--heads', 'origin', params.branch],
    auth
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

/**
 * One `git status --porcelain` line → the changed path. Exported for tests.
 * git() trims stdout, so the FIRST line may have lost its leading status
 * space (' M _site.json' → 'M _site.json') — a fixed slice(3) then eats the
 * path's first character. Strip the 1–2 char status code explicitly.
 */
export const parsePorcelainLine = (line: string) => {
  const path = line
    .replace(/^[ MADRCU?!]{1,2}\s+/, '')
    .trim()
    .replace(/^"|"$/g, '');
  // Renames list as 'old -> new'; the new path is what exists on disk.
  const arrow = path.indexOf(' -> ');
  return arrow === -1 ? path : path.slice(arrow + 4);
};

export const changedFiles = async (dir: string) => {
  const output = await git(dir, ['status', '--porcelain']);
  if (!output) {
    return [];
  }
  return output.split('\n').map(parsePorcelainLine);
};

export const discardChanges = async (dir: string) => {
  await git(dir, ['reset', '--hard']);
  await git(dir, ['clean', '-fd']);
};

/**
 * Discards everything on `branch` (committed history + working tree) and points
 * it back at the latest production default branch, then force-pushes so the
 * remote preview branch matches. Used by "discard session": the running dev
 * server HMRs the reverted files, no restart.
 */
export const resetBranchToDefault = async (params: {
  dir: string;
  branch: string;
}) => {
  const auth = authFor(params.dir);
  await git(params.dir, ['fetch', 'origin', '--prune'], auth);
  const base = await defaultBranch(params.dir);
  await git(params.dir, ['checkout', '-B', params.branch, `origin/${base}`]);
  await git(params.dir, ['clean', '-fd']);
  await git(params.dir, ['push', '--force', 'origin', params.branch], auth);
};

/**
 * Publishes a session branch: squashes it into the repo's default branch as
 * ONE commit authored by `author` (the project owner — services that license
 * git contributors, like Netlify, then see a known collaborator on the branch
 * they build), and pushes. Replaces the old GitHub PR + API squash-merge,
 * whose squash commit was always authored by the app bot.
 *
 * The clone ends up checked out on the default branch on success (the session
 * is closed right after); on conflict/failure it is restored to the session
 * branch so the live session keeps working.
 */
export const squashIntoDefault = async (params: {
  dir: string;
  branch: string;
  message: string;
  author?: { name: string; email: string } | null;
}): Promise<{ sha: string | null; changed: boolean; conflict: boolean }> => {
  const auth = authFor(params.dir);
  // Committer is always the bot identity; --author (which beats the
  // GIT_AUTHOR_* env, unlike -c user.*) carries the owner. GitHub renders
  // "owner authored and bot committed" — transparent about the AI, while
  // git-contributor licensing (Netlify) only counts authors.
  const identity = [
    '-c',
    `user.name=${config.gitAuthorName}`,
    '-c',
    `user.email=${config.gitAuthorEmail}`,
  ];
  const authorFlag = params.author
    ? [`--author=${params.author.name} <${params.author.email}>`]
    : [];

  await git(params.dir, ['fetch', 'origin', '--prune'], auth);
  const base = await defaultBranch(params.dir);

  // Every applied edit is already committed+pushed, so anything loose in the
  // tree is stray (analyzer wrappers are git-excluded and survive this).
  await git(params.dir, ['reset', '--hard']);

  const restoreSessionBranch = async () => {
    await git(params.dir, ['reset', '--hard']).catch(() => '');
    await git(params.dir, ['checkout', params.branch]).catch(() => '');
  };

  await git(params.dir, ['checkout', '-B', base, `origin/${base}`]);
  try {
    await git(params.dir, ['merge', '--squash', params.branch]);
  } catch {
    // Conflict with newer production commits — nothing is lost: the session
    // branch keeps every edit. Hand the decision back to the caller.
    await git(params.dir, ['reset', '--hard', `origin/${base}`]).catch(() => '');
    await restoreSessionBranch();
    return { sha: null, changed: true, conflict: true };
  }

  const staged = await git(params.dir, ['diff', '--cached', '--name-only']);
  if (!staged.trim()) {
    // Branch adds nothing over production — a clean no-op publish.
    await restoreSessionBranch();
    return { sha: null, changed: false, conflict: false };
  }

  await git(params.dir, [...identity, 'commit', '-m', params.message, ...authorFlag]);
  try {
    await git(params.dir, ['push', 'origin', base], auth);
  } catch (error) {
    // Base moved between fetch and push (rare race) — treat like a conflict:
    // drop the local squash commit and keep the session intact.
    await git(params.dir, ['reset', '--hard', `origin/${base}`]).catch(() => '');
    await restoreSessionBranch();
    const message = error instanceof Error ? error.message : 'push failed';
    if (/non-fast-forward|fetch first|rejected/i.test(message)) {
      return { sha: null, changed: true, conflict: true };
    }
    throw error;
  }
  const sha = await git(params.dir, ['rev-parse', 'HEAD']);
  return { sha, changed: true, conflict: false };
};

export const commitAndPush = async (params: {
  dir: string;
  branch: string;
  message: string;
  /**
   * Commit identity override (the session's owner attribution — a real
   * collaborator for git-contributor licensing like Netlify's). Falls back to
   * the GIT_AUTHOR_* env (the app bot).
   */
  author?: { name: string; email: string } | null;
}) => {
  // Committer is always the bot identity; --author (which beats the
  // GIT_AUTHOR_* env, unlike -c user.*) carries the owner — GitHub shows
  // "owner authored and bot committed" on every session commit.
  const identity = [
    '-c',
    `user.name=${config.gitAuthorName}`,
    '-c',
    `user.email=${config.gitAuthorEmail}`,
  ];
  const authorFlag = params.author
    ? [`--author=${params.author.name} <${params.author.email}>`]
    : [];
  const auth = authFor(params.dir);
  await git(params.dir, ['add', '-A']);
  await git(params.dir, [...identity, 'commit', '-m', params.message, ...authorFlag]);
  try {
    await git(params.dir, ['push', '-u', 'origin', params.branch], auth);
  } catch (error) {
    // Only a branch that already exists remotely can have moved under us —
    // rebase once and retry. For a brand-new branch, rethrow the real error.
    const remoteHead = await git(
      params.dir,
      ['ls-remote', '--heads', 'origin', params.branch],
      auth
    );
    if (!remoteHead.trim()) throw error;
    await git(params.dir, [...identity, 'pull', '--rebase', 'origin', params.branch], auth);
    await git(params.dir, ['push', '-u', 'origin', params.branch], auth);
  }
  return git(params.dir, ['rev-parse', 'HEAD']);
};
