import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Source replace for uploaded projects (hub "Import" inside a project): real
// git, no network. Env pinned before the dynamic import.
const ws = mkdtempSync(join(tmpdir(), 'cp-replace-'));
process.env.WORKSPACE_DIR = ws;
process.env.GIT_AUTHOR_NAME = 'Fallback Bot';
process.env.GIT_AUTHOR_EMAIL = 'bot@fallback.local';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_APP_PRIVATE_KEY = '';
process.env.GITHUB_BACKUP_ORG = '';
process.env.GITHUB_BACKUP_TOKEN = '';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const P = '22222222-2222-4222-8222-222222222222';

const sh = (cwd: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@test', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

type Mod = typeof import('./replace');
let r: Mod;
let work: string;
let n = 0;

const write = (root: string, files: Record<string, string>) => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
};

const stage = (files: Record<string, string>) => {
  const dir = join(ws, '.imports', `stage-${n++}`);
  mkdirSync(dir, { recursive: true });
  write(dir, files);
  return dir;
};

// An Astro upload with installed deps, a build, and a live session branch.
before(async () => {
  r = await import('./replace');
  work = join(ws, P);
  execFileSync('git', ['init', '-q', work]);
  sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  write(work, {
    'package.json': '{"dependencies":{"astro":"5.0.0"}}',
    'astro.config.mjs': 'export default {}',
    'src/pages/index.astro': '<h1>astro</h1>',
    '.gitignore': 'node_modules\ndist\n',
  });
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Import astro-site']);
  write(work, {
    'node_modules/astro/index.js': '',
    'node_modules/.cp-install-hash': 'abc',
    'dist/index.html': 'old build',
  });
  sh(work, ['config', 'cp.backupRepo', 'astro-site-22222222']);
  sh(work, ['checkout', '-qb', 'preview/s1']);
  write(work, { 'src/pages/index.astro': '<h1>unpublished edit</h1>' });
  sh(work, ['commit', '-qam', 'AI edit']);
});

test('astro → static: only the new files remain, deps and build output are gone', async () => {
  const staging = stage({ 'index.html': '<h1>static</h1>', 'about/index.html': 'about' });
  const { sha } = await r.replaceWorkspace({
    projectId: P,
    staging,
    name: 'static-site',
    author: { name: 'Owner', email: 'owner@test' },
  });
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), '<h1>static</h1>');
  for (const stale of ['package.json', 'astro.config.mjs', 'src', 'node_modules', 'dist', '.gitignore']) {
    assert.equal(existsSync(join(work, stale)), false, `${stale} should be gone`);
  }
  assert.equal(existsSync(staging), false);
  assert.equal(sh(work, ['status', '--porcelain']), '');
});

test('history is preserved: the replace is one commit on top of main, authored by the uploader', () => {
  assert.equal(sh(work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.deepEqual(sh(work, ['log', '--format=%s', 'main']).split('\n'), [
    'Replace source with static-site',
    'Import astro-site',
  ]);
  assert.equal(sh(work, ['log', '-1', '--format=%an <%ae>|%cn']), 'Owner <owner@test>|Fallback Bot');
});

test('the unpublished session edit never reaches main and preview branches are deleted', () => {
  assert.equal(sh(work, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']), 'main');
  assert.equal(sh(work, ['log', '--format=%s', 'main']).includes('AI edit'), false);
});

test('git config (backup repo name) carries over', () => {
  assert.equal(sh(work, ['config', '--get', 'cp.backupRepo']), 'astro-site-22222222');
});

test('static → vite honours the NEW .gitignore', async () => {
  const staging = stage({
    'package.json': '{"devDependencies":{"vite":"7.0.0"}}',
    'index.html': '<div id="app"></div>',
    '.gitignore': 'secret.txt\n',
    'secret.txt': 'nope',
  });
  await r.replaceWorkspace({ projectId: P, staging, name: 'vite-site', author: null });
  const tracked = sh(work, ['ls-files']).split('\n').sort();
  assert.deepEqual(tracked, ['.gitignore', 'index.html', 'package.json']);
  assert.equal(existsSync(join(work, 'index.html')), true);
});

test('identical content still commits (empty commit) instead of throwing', async () => {
  const before = sh(work, ['rev-list', '--count', 'main']);
  const staging = stage({
    'package.json': '{"devDependencies":{"vite":"7.0.0"}}',
    'index.html': '<div id="app"></div>',
    '.gitignore': 'secret.txt\n',
  });
  await r.replaceWorkspace({ projectId: P, staging, name: 'same', author: null });
  assert.equal(Number(sh(work, ['rev-list', '--count', 'main'])), Number(before) + 1);
});

test('a failure leaves the original workspace untouched', async () => {
  const head = sh(work, ['rev-parse', 'main']);
  const staging = stage({ 'index.html': 'broken' });
  // A corrupt "main" ref inside the copied .git can't happen naturally; force
  // a failure by asking for an unknown project dir instead.
  await assert.rejects(
    r.replaceWorkspace({
      projectId: '33333333-3333-4333-8333-333333333333',
      staging,
      name: 'x',
      author: null,
    }),
    /Workspace missing/
  );
  assert.equal(sh(work, ['rev-parse', 'main']), head);
  assert.equal(existsSync(join(work, 'index.html')), true);
});

test('the replace lock is exclusive and released', async () => {
  const release = await r.acquireReplaceLock(P);
  assert.ok(release);
  assert.equal(r.isReplacing(P), true);
  assert.equal(await r.acquireReplaceLock(P), null);
  await release!();
  assert.equal(r.isReplacing(P), false);
  const again = await r.acquireReplaceLock(P);
  assert.ok(again);
  await again!();
});
