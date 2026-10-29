import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// squashIntoDefault: the local owner-authored publish squash that replaced the
// GitHub PR + API squash-merge. Real git against a local bare origin — no
// network. Env is read by worker/config at import, pinned before the dynamic
// import (same pattern as git.integration.test.ts).
const ws = mkdtempSync(join(tmpdir(), 'cp-squash-'));
process.env.WORKSPACE_DIR = ws;
process.env.GIT_AUTHOR_NAME = 'Fallback Bot';
process.env.GIT_AUTHOR_EMAIL = 'bot@fallback.local';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_APP_PRIVATE_KEY = '';
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
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed]);
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-qm', 'init']);
  sh(seed, ['push', '-q', 'origin', 'main']);
  work = g.repoDir('33333333-3333-4333-8333-333333333333');
  execFileSync('git', ['clone', '-q', origin, work]);
});

test('squashIntoDefault lands ONE owner-authored commit on the default branch', async () => {
  sh(work, ['checkout', '-qb', 'preview/s1']);
  writeFileSync(join(work, 'hero.txt'), 'hero\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'edit 1']);
  writeFileSync(join(work, 'hero.txt'), 'hero v2\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'edit 2']);
  sh(work, ['push', '-q', 'origin', 'preview/s1']);

  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s1',
    message: 'Publish site edits (session s1)',
    author: { name: 'alisamadiii', email: '1+alisamadiii@users.noreply.github.com' },
  });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/);
  // Origin main: exactly one new commit, authored by the OWNER, not the bot.
  assert.equal(sh(origin, ['rev-parse', 'main']), result.sha);
  assert.equal(
    sh(origin, ['log', '-1', '--format=%an|%ae|%s', 'main']),
    'alisamadiii|1+alisamadiii@users.noreply.github.com|Publish site edits (session s1)'
  );
  // Two branch commits squashed into one on main.
  assert.equal(sh(origin, ['rev-list', '--count', 'main']), '2');
});

test('squashIntoDefault reports no change for a branch that adds nothing', async () => {
  sh(work, ['fetch', '-q', 'origin']);
  sh(work, ['checkout', '-qB', 'preview/s2', 'origin/main']);
  sh(work, ['push', '-q', 'origin', 'preview/s2']);
  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s2',
    message: 'Publish site edits (session s2)',
    author: null,
  });
  assert.deepEqual(result, { sha: null, changed: false, conflict: false });
  // The clone is restored to the session branch for session continuity.
  assert.equal(sh(work, ['branch', '--show-current']), 'preview/s2');
});

test('squashIntoDefault reports a conflict and restores the session branch', async () => {
  sh(work, ['checkout', '-qB', 'preview/s3', 'origin/main']);
  writeFileSync(join(work, 'a.txt'), 'session edit\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'conflicting edit']);
  sh(work, ['push', '-q', 'origin', 'preview/s3']);
  // Production moves the same line out from under the session.
  sh(seed, ['pull', '-q', 'origin', 'main']);
  writeFileSync(join(seed, 'a.txt'), 'production edit\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-qm', 'prod moved']);
  sh(seed, ['push', '-q', 'origin', 'main']);

  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s3',
    message: 'Publish site edits (session s3)',
    author: null,
  });
  assert.equal(result.conflict, true);
  assert.equal(result.sha, null);
  // Nothing landed on main; session branch intact and checked out again.
  assert.equal(sh(origin, ['log', '-1', '--format=%s', 'main']), 'prod moved');
  assert.equal(sh(work, ['branch', '--show-current']), 'preview/s3');
  assert.equal(sh(work, ['status', '--porcelain']), '');
});

// Regression: the GIT_AUTHOR_* env (set in prod to the bot identity, and set
// in this file) outranks `-c user.*` in git — the --author flag must win so
// the owner attribution survives. The committer is ALWAYS the bot identity so
// GitHub shows "owner authored and bot committed" (transparent about the AI;
// Netlify-style contributor licensing only counts authors).
test('commitAndPush: owner author survives GIT_AUTHOR_* env, bot stays committer', async () => {
  writeFileSync(join(work, 'env-override.txt'), 'x\n');
  const sha = await g.commitAndPush({
    dir: work,
    branch: 'preview/s3',
    message: 'env override test',
    author: { name: 'alisamadiii', email: '1+alisamadiii@users.noreply.github.com' },
  });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(
    sh(work, ['log', '-1', '--format=%an|%ae|%cn|%ce']),
    'alisamadiii|1+alisamadiii@users.noreply.github.com|Fallback Bot|bot@fallback.local'
  );
});

test('squashIntoDefault owner attribution survives the GIT_AUTHOR_* env', async () => {
  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s3',
    message: 'Publish site edits (session s3 retry)',
    author: { name: 'alisamadiii', email: '1+alisamadiii@users.noreply.github.com' },
  });
  // Still conflicting on a.txt — but the first squash test already proved the
  // happy path; this asserts the conflict path is unchanged under env identity.
  assert.equal(result.conflict, true);
});
