import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Origin-less (uploaded-project) behavior of the git layer: no fetch, no push,
// local main stands in for origin/<default>. Real git, no network. Env pinned
// before the dynamic import (same pattern as git.squash.test.ts).
const ws = mkdtempSync(join(tmpdir(), 'cp-local-'));
process.env.WORKSPACE_DIR = ws;
process.env.GIT_AUTHOR_NAME = 'Fallback Bot';
process.env.GIT_AUTHOR_EMAIL = 'bot@fallback.local';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_APP_PRIVATE_KEY = '';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const sh = (cwd: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@test', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

type Mod = typeof import('./git');
let g: Mod;
let work: string;

// An uploaded workspace: git init on main, one import commit, NO origin.
before(async () => {
  g = await import('./git');
  work = g.repoDir('11111111-1111-4111-8111-111111111111');
  execFileSync('git', ['init', '-q', work]);
  sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(work, 'index.html'), '<h1>v1</h1>\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Import site']);
});

test('hasOrigin is false for an uploaded workspace, baseRef is local main', async () => {
  assert.equal(await g.hasOrigin(work), false);
  assert.equal(await g.baseRef(work), 'main');
});

test('syncLocalRepo creates the session branch off main with a clean tree', async () => {
  writeFileSync(join(work, 'stray.txt'), 'stray\n');
  const dir = await g.syncLocalRepo({ projectId: '11111111-1111-4111-8111-111111111111', branch: 'preview/s1' });
  assert.equal(dir, work);
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'preview/s1');
  assert.equal(existsSync(join(work, 'stray.txt')), false);
});

test('commitAndPush commits locally and skips the push when there is no origin', async () => {
  writeFileSync(join(work, 'index.html'), '<h1>v2</h1>\n');
  const sha = await g.commitAndPush({
    dir: work,
    branch: 'preview/s1',
    message: 'AI edit',
    author: { name: 'Ali', email: 'ali@test.local' },
  });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(sh(work, ['log', '-1', '--format=%an|%s']), 'Ali|AI edit');
  // No origin remote was ever added or pushed to.
  assert.equal(await g.hasOrigin(work), false);
});

test('squashIntoDefault squashes into local main without any remote', async () => {
  writeFileSync(join(work, 'about.html'), '<h1>about</h1>\n');
  await g.commitAndPush({ dir: work, branch: 'preview/s1', message: 'AI edit 2' });
  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s1',
    message: 'Publish site edits (session s1)',
    author: { name: 'Ali', email: 'ali@test.local' },
  });
  assert.equal(result.conflict, false);
  assert.equal(result.changed, true);
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(sh(work, ['rev-parse', 'main']), result.sha);
  assert.equal(
    sh(work, ['log', '-1', '--format=%an|%ae|%s', 'main']),
    'Ali|ali@test.local|Publish site edits (session s1)'
  );
  // Import commit + one squash commit.
  assert.equal(sh(work, ['rev-list', '--count', 'main']), '2');
});

test('squashIntoDefault is a clean no-op when the branch adds nothing', async () => {
  // The branch was just squashed into main; rebuild it fresh from main.
  await g.syncLocalRepo({ projectId: '11111111-1111-4111-8111-111111111111', branch: 'preview/s2' });
  const result = await g.squashIntoDefault({
    dir: work,
    branch: 'preview/s2',
    message: 'Publish (empty)',
  });
  assert.equal(result.changed, false);
  assert.equal(result.conflict, false);
  assert.equal(result.sha, null);
  // Restored onto the session branch.
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'preview/s2');
});

test('resetBranchToDefault discards local branch commits back to main', async () => {
  writeFileSync(join(work, 'junk.html'), 'junk\n');
  await g.commitAndPush({ dir: work, branch: 'preview/s2', message: 'discard me' });
  await g.resetBranchToDefault({ dir: work, branch: 'preview/s2' });
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'preview/s2');
  assert.equal(sh(work, ['rev-parse', 'preview/s2']), sh(work, ['rev-parse', 'main']));
  assert.equal(existsSync(join(work, 'junk.html')), false);
});

test('syncLocalRepo revives an existing branch instead of recreating it', async () => {
  writeFileSync(join(work, 'keep.html'), 'keep\n');
  await g.commitAndPush({ dir: work, branch: 'preview/s2', message: 'kept edit' });
  const kept = sh(work, ['rev-parse', 'preview/s2']);
  // Simulate a pause/revive: switch away, then sync back.
  sh(work, ['checkout', '-q', 'main']);
  await g.syncLocalRepo({ projectId: '11111111-1111-4111-8111-111111111111', branch: 'preview/s2' });
  assert.equal(sh(work, ['rev-parse', 'HEAD']), kept);
  assert.equal(existsSync(join(work, 'keep.html')), true);
});

test('syncLocalRepo throws a client-facing error when the workspace is gone', async () => {
  await assert.rejects(
    g.syncLocalRepo({ projectId: '22222222-2222-4222-8222-222222222222', branch: 'preview/x' }),
    /missing from the preview server/
  );
});
