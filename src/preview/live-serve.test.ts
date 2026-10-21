import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Live-site builds: label parsing, git-archive of the published sha, the
// framework build to dist/, and the atomic current/ swap. Env pinned
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

// DELIBERATE CHANGE (static-only pivot): refreshLiveSnapshot (static-only,
// git archive of main) became buildLiveSite (every project, the exact
// published sha; astro/vite build to dist/). The static snapshot assertions
// carry over unchanged in spirit.
const head = (dir: string) => sh(dir, ['rev-parse', 'HEAD']);

test('buildLiveSite writes the committed tree of a static site into current/', async () => {
  await ls.buildLiveSite({ repoId: REPO_ID, sha: head(work) });
  const root = ls.liveServeRoot(REPO_ID);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>v1</h1>\n');
  assert.equal(existsSync(join(root, '.git')), false);
  assert.equal(ls.hasLiveSite(REPO_ID), true);
});

test('rebuild after a publish swaps content and removes stale files', async () => {
  // New main state: index changed, style.css deleted, uncommitted file ignored.
  writeFileSync(join(work, 'index.html'), '<h1>v2</h1>\n');
  sh(work, ['rm', '-q', 'style.css']);
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Publish']);
  writeFileSync(join(work, 'uncommitted.html'), 'never served\n');

  await ls.buildLiveSite({ repoId: REPO_ID, sha: head(work) });
  const root = ls.liveServeRoot(REPO_ID);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>v2</h1>\n');
  assert.equal(existsSync(join(root, 'style.css')), false);
  assert.equal(existsSync(join(root, 'uncommitted.html')), false);
});

test('buildLiveSite builds the exact sha, not the branch tip', async () => {
  const published = head(work);
  writeFileSync(join(work, 'index.html'), '<h1>unpublished</h1>\n');
  sh(work, ['commit', '-qam', 'Later commit']);
  await ls.buildLiveSite({ repoId: REPO_ID, sha: published });
  assert.equal(
    readFileSync(join(ls.liveServeRoot(REPO_ID), 'index.html'), 'utf8'),
    '<h1>v2</h1>\n'
  );
});

// A Vite-shaped project whose build script is plain node (no network install:
// package.json has no deps, the vite.config file alone marks it as vite).
const viteProject = (id: number, buildScript: string, extra: Record<string, string> = {}) => {
  const dir = join(ws, String(id));
  execFileSync('git', ['init', '-q', dir]);
  sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'site', private: true, scripts: { build: buildScript } })
  );
  writeFileSync(join(dir, 'vite.config.js'), 'export default {};\n');
  writeFileSync(join(dir, 'index.html'), '<h1>source</h1>\n');
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'Import vite project']);
  return dir;
};

const writeDist = (html: string) =>
  `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html',${JSON.stringify(html).replace(/"/g, "'")})"`;

test('framework projects are built and ONLY dist/ goes live', async () => {
  const id = 1000000000077;
  const dir = viteProject(id, writeDist('<h1>built</h1>'));
  await ls.buildLiveSite({ repoId: id, sha: head(dir) });
  const root = ls.liveServeRoot(id);
  assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), '<h1>built</h1>');
  assert.equal(existsSync(join(root, 'package.json')), false);
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('a failing build throws BuildError and keeps the previous live site', async () => {
  const id = 1000000000077;
  const dir = join(ws, String(id));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'site', private: true, scripts: { build: 'node -e "process.exit(3)"' } })
  );
  sh(dir, ['commit', '-qam', 'Break the build']);
  await assert.rejects(
    ls.buildLiveSite({ repoId: id, sha: head(dir) }),
    (error: unknown) => error instanceof ls.BuildError && /build failed/i.test(error.message)
  );
  assert.equal(
    readFileSync(join(ls.liveServeRoot(id), 'index.html'), 'utf8'),
    '<h1>built</h1>'
  );
});

test('a build without dist/index.html fails instead of going live empty', async () => {
  const id = 1000000000088;
  const dir = viteProject(id, 'node -e "0"');
  await assert.rejects(
    ls.buildLiveSite({ repoId: id, sha: head(dir) }),
    (error: unknown) => error instanceof ls.BuildError && /dist\/index\.html/.test(error.message)
  );
  assert.equal(ls.hasLiveSite(id), false);
});

test('a build that emits a server bundle is refused', async () => {
  const id = 1000000000099;
  const dir = viteProject(
    id,
    `node -e "const f=require('fs');f.mkdirSync('dist/server',{recursive:true});f.writeFileSync('dist/index.html','x')"`
  );
  await assert.rejects(
    ls.buildLiveSite({ repoId: id, sha: head(dir) }),
    (error: unknown) => error instanceof ls.BuildError && /server bundle/.test(error.message)
  );
  assert.equal(ls.hasLiveSite(id), false);
});

test('builds never see the pilot secrets in their env', async () => {
  const id = 1000000000111;
  process.env.DATABASE_URL = 'postgres://secret@db/pilot';
  process.env.GITHUB_APP_PRIVATE_KEY = 'secret-key';
  const dir = viteProject(
    id,
    `node -e "const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/index.html',JSON.stringify([process.env.DATABASE_URL||'',process.env.GITHUB_APP_PRIVATE_KEY||'',process.env.NODE_ENV]))"`
  );
  await ls.buildLiveSite({ repoId: id, sha: head(dir) });
  assert.equal(
    readFileSync(join(ls.liveServeRoot(id), 'index.html'), 'utf8'),
    JSON.stringify(['', '', 'production'])
  );
});

test('unsupported projects (Next.js) never build', async () => {
  const id = 1000000000122;
  const dir = join(ws, String(id));
  execFileSync('git', ['init', '-q', dir]);
  sh(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(dir, 'package.json'), '{"dependencies":{"next":"15"}}\n');
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-qm', 'Next project']);
  await assert.rejects(
    ls.buildLiveSite({ repoId: id, sha: head(dir) }),
    (error: unknown) => error instanceof ls.BuildError && /Next\.js/.test(error.message)
  );
  assert.equal(ls.hasLiveSite(id), false);
});

test('buildLiveSite rejects a non-sha ref (shell safety)', async () => {
  await assert.rejects(
    ls.buildLiveSite({ repoId: REPO_ID, sha: 'main; rm -rf /' }),
    (error: unknown) => error instanceof ls.BuildError
  );
});

test('buildCommand: astro uses the static wrapper; vite prefers the build script', async () => {
  assert.deepEqual(ls.buildCommand('astro', work), [
    'npx',
    ['astro', 'build', '--config', 'cp-build.astro.config.mjs', '--root', '.'],
  ]);
  assert.deepEqual(ls.buildCommand('vite', join(ws, '1000000000077')), ['npm', ['run', 'build']]);
  assert.deepEqual(ls.buildCommand('vite', work), ['npx', ['vite', 'build']]);
});

test('removeLiveSnapshot takes the site down', async () => {
  await ls.removeLiveSnapshot(REPO_ID);
  assert.equal(existsSync(ls.liveServeRoot(REPO_ID)), false);
});
