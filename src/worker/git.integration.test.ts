import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real git against a local bare "origin" — no network, no GitHub. Env is read
// by worker/config at import, so it's pinned before the dynamic import.
const ws = mkdtempSync(join(tmpdir(), 'cp-git-'));
process.env.WORKSPACE_DIR = ws;
process.env.GITHUB_PAT = 'ghp_supersecret123';
process.env.GIT_AUTHOR_NAME = 'Test Bot';
process.env.GIT_AUTHOR_EMAIL = 'bot@test.local';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const sh = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@test', ...args], { cwd, encoding: 'utf8' }).trim();

const origin = join(ws, 'origin.git');
const seed = join(ws, 'seed');
type Mod = typeof import('./git');
let g: Mod;
let work: string;

before(async () => {
  g = await import('./git');
  // config captured the bot identity; drop the env so git itself can't fall
  // back on it — the `-c user.*` flags in commitAndPush must do the work.
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  // Origin refuses pushes to preview/new (see the brand-new-branch test).
  writeFileSync(
    join(origin, 'hooks', 'pre-receive'),
    '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/heads/preview/new) echo "preview/new is locked" >&2; exit 1;; esac; done\nexit 0\n'
  );
  chmodSync(join(origin, 'hooks', 'pre-receive'), 0o755);
  execFileSync('git', ['clone', '-q', origin, seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  writeFileSync(join(seed, '_site.json'), '{}\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-qm', 'init']);
  sh(seed, ['push', '-q', 'origin', 'main']);
  work = g.repoDir(42);
  execFileSync('git', ['clone', '-q', origin, work]);
});

// ------------------------------------------------------------------ pure

test('sanitize redacts the PAT and any basic auth header, leaves the rest', async () => {
  assert.equal(
    g.sanitize('fatal: https://x-access-token:ghp_supersecret123@github.com/a/b.git failed; Authorization: Basic abc+/= done'),
    'fatal: https://x-access-token:[REDACTED]@github.com/a/b.git failed; Authorization: [REDACTED] done'
  );
  assert.equal(g.sanitize('clean message'), 'clean message');
});

test('repoDir is <WORKSPACE_DIR>/<repoId>', () => {
  assert.equal(g.repoDir(42), join(ws, '42'));
});

test('ensureGitExclude appends once, handles a missing trailing newline, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-excl-'));
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  const file = join(dir, '.git', 'info', 'exclude');
  g.ensureGitExclude(dir, 'ai-analyzer/');
  g.ensureGitExclude(dir, 'ai-analyzer/');
  assert.equal(readFileSync(file, 'utf8'), 'ai-analyzer/\n');
  writeFileSync(file, 'existing');
  g.ensureGitExclude(dir, 'next.config.mjs');
  assert.equal(readFileSync(file, 'utf8'), 'existing\nnext.config.mjs\n');
  // A line already present (even with stray whitespace in the file) is not re-added.
  writeFileSync(file, 'existing\n  next.config.mjs  \n');
  g.ensureGitExclude(dir, 'next.config.mjs');
  assert.equal(readFileSync(file, 'utf8'), 'existing\n  next.config.mjs  \n');
  assert.doesNotThrow(() => g.ensureGitExclude(join(tmpdir(), 'cp-no-git'), 'x'));
});

// ------------------------------------------------------------ working tree

test('changedFiles: clean → [], then untracked + modified (first porcelain line survives trim)', async () => {
  assert.deepEqual(await g.changedFiles(work), []);
  writeFileSync(join(work, 'a.txt'), 'changed\n');
  writeFileSync(join(work, 'b new.txt'), 'x');
  assert.deepEqual(await g.changedFiles(work), ['a.txt', 'b new.txt']);
});

test('discardChanges restores tracked files and removes untracked ones', async () => {
  await g.discardChanges(work);
  assert.deepEqual(await g.changedFiles(work), []);
  assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(existsSync(join(work, 'b new.txt')), false);
});

test('git() rejects with a sanitized message on failure', async () => {
  await assert.rejects(g.git(work, ['rev-parse', 'does-not-exist-ref']), /does-not-exist-ref/);
  await assert.rejects(g.git(work, ['checkout', 'ghp_supersecret123']), (e: Error) => !e.message.includes('ghp_supersecret123'));
});

// ------------------------------------------------------------- commit/push

test('commitAndPush commits with the bot identity and pushes the branch to origin', async () => {
  sh(work, ['checkout', '-qb', 'preview/t1']);
  writeFileSync(join(work, 'hero.txt'), 'hero');
  const sha = await g.commitAndPush({ dir: work, branch: 'preview/t1', message: 'AI session edit: hero' });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sh(origin, ['rev-parse', 'preview/t1']), sha);
  assert.equal(sh(work, ['log', '-1', '--format=%an|%ae|%s']), 'Test Bot|bot@test.local|AI session edit: hero');
  assert.deepEqual(await g.changedFiles(work), []);
});

test('commitAndPush rebases and retries when the remote branch moved under us', async () => {
  sh(seed, ['fetch', '-q', 'origin']);
  sh(seed, ['checkout', '-qB', 'preview/t1', 'origin/preview/t1']);
  writeFileSync(join(seed, 'remote.txt'), 'from elsewhere');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-qm', 'remote edit']);
  sh(seed, ['push', '-q', 'origin', 'preview/t1']);

  writeFileSync(join(work, 'local.txt'), 'local');
  const sha = await g.commitAndPush({ dir: work, branch: 'preview/t1', message: 'local edit' });
  assert.equal(sh(origin, ['rev-parse', 'preview/t1']), sha);
  const subjects = sh(work, ['log', '--format=%s', '-3']).split('\n');
  assert.deepEqual(subjects, ['local edit', 'remote edit', 'AI session edit: hero']);
  assert.equal(existsSync(join(work, 'remote.txt')), true);
});

test('commitAndPush on a brand-new branch rethrows the real push error (no rebase attempt)', async () => {
  sh(work, ['checkout', '-qb', 'preview/new']);
  writeFileSync(join(work, 'n.txt'), 'n');
  try {
    // The hook's message is the push error; a rebase attempt against the
    // (nonexistent) remote branch would surface a different error instead.
    await assert.rejects(
      g.commitAndPush({ dir: work, branch: 'preview/new', message: 'x' }),
      /preview\/new is locked/
    );
  } finally {
    sh(work, ['checkout', '-q', 'preview/t1']);
    sh(work, ['branch', '-qD', 'preview/new']);
  }
});

// ------------------------------------------------------------------ reset

test('resetBranchToDefault points the branch back at origin/main, cleans, and force-pushes', async () => {
  writeFileSync(join(work, 'junk.txt'), 'untracked');
  const mainSha = sh(origin, ['rev-parse', 'main']);
  assert.notEqual(sh(origin, ['rev-parse', 'preview/t1']), mainSha, 'precondition: branch has edits');
  await g.resetBranchToDefault({ dir: work, branch: 'preview/t1' });
  assert.equal(sh(work, ['rev-parse', 'HEAD']), mainSha);
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'preview/t1');
  assert.equal(sh(origin, ['rev-parse', 'preview/t1']), mainSha);
  assert.equal(existsSync(join(work, 'junk.txt')), false);
  assert.equal(existsSync(join(work, 'hero.txt')), false);
});
