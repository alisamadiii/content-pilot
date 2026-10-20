import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Live-serve snapshots for uploaded static projects: label parsing, the
// git-archive snapshot of local main, and the atomic current/ swap. Env pinned
// before the dynamic import (worker/config reads it at import time).
const ws = mkdtempSync(join(tmpdir(), 'cp-live-'));
process.env.WORKSPACE_DIR = ws;
process.env.PREVIEW_URL_BASE = 'http://{id}.localhost:3020';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const sh = (cwd: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@test', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

const REPO_ID = 1000000000055;
type Mod = typeof import('./live-serve');
let ls: Mod;
let work: string;

before(async () => {
  ls = await import('./live-serve');
  work = join(ws, String(REPO_ID));
  execFileSync('git', ['init', '-q', work]);
  sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(work, 'index.html'), '<h1>v1</h1>\n');
  writeFileSync(join(work, 'style.css'), 'body{}\n');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Import site']);
});

test('repoIdFromLiveLabel parses site-<id> and rejects everything else', () => {
  assert.equal(ls.repoIdFromLiveLabel('site-1000000000055'), 1000000000055);
  assert.equal(ls.repoIdFromLiveLabel('site-42'), 42);
  assert.equal(ls.repoIdFromLiveLabel('site-0'), null);
  assert.equal(ls.repoIdFromLiveLabel('site-'), null);
  assert.equal(ls.repoIdFromLiveLabel('site-abc'), null);
  assert.equal(ls.repoIdFromLiveLabel('site-1x2'), null);
  assert.equal(ls.repoIdFromLiveLabel('abcdef123456'), null); // session id shape
  assert.equal(ls.repoIdFromLiveLabel('SITE-42'), null);
  assert.equal(ls.repoIdFromLiveLabel('site-12345678901234567'), null); // >16 digits
});

test('liveUrlFor builds from the preview url base', () => {
  assert.equal(ls.liveUrlFor(42), 'http://site-42.localhost:3020');
});

test('refreshLiveSnapshot writes the committed main tree into current/', async () => {
  const url = await ls.refreshLiveSnapshot(REPO_ID);
  assert.equal(url, `http://site-${REPO_ID}.localhost:3020`);
  const root = ls.liveServeRoot(REPO_ID);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>v1</h1>\n');
  assert.equal(existsSync(join(root, '.git')), false);
});

test('refresh after a publish swaps content and removes stale files', async () => {
  // New main state: index changed, style.css deleted, uncommitted file ignored.
  writeFileSync(join(work, 'index.html'), '<h1>v2</h1>\n');
  sh(work, ['rm', '-q', 'style.css']);
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Publish']);
  writeFileSync(join(work, 'uncommitted.html'), 'never served\n');

  await ls.refreshLiveSnapshot(REPO_ID);
  const root = ls.liveServeRoot(REPO_ID);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>v2</h1>\n');
  assert.equal(existsSync(join(root, 'style.css')), false);
  assert.equal(existsSync(join(root, 'uncommitted.html')), false);
});

test('refreshLiveSnapshot is a no-op (null) for non-static workspaces', async () => {
  const fwId = 1000000000066;
  const fwDir = join(ws, String(fwId));
  execFileSync('git', ['init', '-q', fwDir]);
  sh(fwDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(fwDir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(join(fwDir, 'index.html'), 'x\n');
  sh(fwDir, ['add', '-A']);
  sh(fwDir, ['commit', '-qm', 'Import framework project']);
  assert.equal(await ls.refreshLiveSnapshot(fwId), null);
  assert.equal(existsSync(ls.liveServeRoot(fwId)), false);
});

test('removeLiveSnapshot takes the site down', async () => {
  await ls.removeLiveSnapshot(REPO_ID);
  assert.equal(existsSync(ls.liveServeRoot(REPO_ID)), false);
});
