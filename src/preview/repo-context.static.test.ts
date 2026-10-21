import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRepoContext, collectRoutes, resolvePageFile } from './repo-context';

// Repo-context for plain static repos (framework 'static', 2026-10-20). The
// framework fixtures live in repo-context.test.ts; these cover the static
// branch: multi-page .html route maps, .html path normalization, root publicRel.

const staticFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-static-ctx-'));
  const files: Record<string, string> = {
    'index.html': '<h1>Home</h1>',
    'about.html': '<h1>About</h1>',
    'team/index.html': '<h1>Team</h1>',
    'style.css': 'h1{color:red}',
    'scripts/main.js': 'console.log(1)',
    'images/team/a.webp': '',
    'images/hero.webp': '',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
};

test('collectRoutes (static): every .html file becomes a page', async () => {
  const dir = await staticFixture();
  const routes = await collectRoutes(dir, 'static');
  assert.deepEqual(
    [...routes.entries()].sort(),
    [
      ['/', 'index.html'],
      ['/about', 'about.html'],
      ['/team', 'team/index.html'],
    ].sort()
  );
});

test('resolvePageFile normalizes the .html URLs the overlay posts', async () => {
  const dir = await staticFixture();
  const routes = await collectRoutes(dir, 'static');
  assert.equal(resolvePageFile(routes, '/'), 'index.html');
  assert.equal(resolvePageFile(routes, '/index.html'), 'index.html');
  assert.equal(resolvePageFile(routes, '/about.html'), 'about.html');
  assert.equal(resolvePageFile(routes, '/about'), 'about.html');
  assert.equal(resolvePageFile(routes, '/team/'), 'team/index.html');
  assert.equal(resolvePageFile(routes, '/team/index.html'), 'team/index.html');
  assert.equal(resolvePageFile(routes, '/missing.html'), null);
});

test('buildRepoContext (static root): framework static, empty publicRel, root image hints', async () => {
  const dir = await staticFixture();
  const ctx = await buildRepoContext(dir);
  assert.equal(ctx.framework, 'static');
  assert.equal(ctx.publicRel, '');
  assert.ok(ctx.routes.size >= 3);
  assert.ok(ctx.imageDirs.some((h) => h.dir === 'images/team'));
  assert.match(ctx.text, /Framework: static/);
  assert.match(ctx.text, /repo root/);
  assert.match(ctx.text, /- \/about → about\.html/);
});

// DELIBERATE CHANGE (root-only sites): app-folder override removed; the
// static-in-subfolder publicRel case went with it.
