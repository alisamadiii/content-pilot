import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { detectFramework } from './framework';
import { devCommand, findAppDir, pilotViteBin } from './session-boot';

// Static-repo boot decisions (GitHub-pages-style sites: index.html + assets,
// no package.json). New behavior added 2026-10-20; the framework-repo paths
// these sit beside are covered by session-boot.test.ts / framework.test.ts.

const fixture = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-static-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
};

test('findAppDir accepts an index.html-only repo root', async () => {
  const dir = await fixture({ 'index.html': '<h1>hi</h1>' });
  assert.equal(findAppDir(dir), dir);
});

test('findAppDir accepts an index.html-only app-folder override', async () => {
  const dir = await fixture({ 'site/index.html': '<h1>hi</h1>' });
  assert.equal(findAppDir(dir, 'site'), join(dir, 'site'));
});

test('findAppDir still rejects a root with neither package.json nor index.html', async () => {
  const dir = await fixture({ 'README.md': 'nothing here' });
  assert.throws(() => findAppDir(dir), /package\.json or index\.html/);
});

test('findAppDir still rejects an override folder with neither marker', async () => {
  const dir = await fixture({ 'site/README.md': 'nope' });
  assert.throws(() => findAppDir(dir, 'site'), /package\.json or index\.html/);
});

test('detectFramework: no package.json + index.html → static', async () => {
  const dir = await fixture({ 'index.html': '<h1>hi</h1>' });
  assert.equal(detectFramework(dir), 'static');
});

test('detectFramework: static wins over a stray vite config when there is no package.json', async () => {
  // A config without installable deps must not route to the 'vite' path, which
  // spawns from the clone's (nonexistent) node_modules.
  const dir = await fixture({
    'index.html': '<h1>hi</h1>',
    'vite.config.js': 'export default {}',
  });
  assert.equal(detectFramework(dir), 'static');
});

test('detectFramework: package.json without index.html keeps the legacy null fallback', async () => {
  const dir = await fixture({ 'package.json': '{"dependencies":{}}' });
  assert.equal(detectFramework(dir), null);
});

test('detectFramework: package.json + vite dep still detects vite, even next to index.html', async () => {
  const dir = await fixture({
    'package.json': '{"devDependencies":{"vite":"^6"}}',
    'index.html': '<div id="app"></div>',
  });
  assert.equal(detectFramework(dir), 'vite');
});

test("pilotViteBin resolves vite from the pilot's own install", () => {
  const bin = pilotViteBin();
  assert.ok(isAbsolute(bin));
  assert.match(bin, /vite[\\/]bin[\\/]vite\.js$/);
});

test('devCommand static: pilot node + pilot vite bin + wrapper config', async () => {
  const dir = await fixture({ 'index.html': '<h1>hi</h1>' });
  const { cmd, args } = devCommand(dir, 4105, {
    framework: 'static',
    configPath: 'ai-analyzer/preview.static.config.mjs',
  });
  assert.equal(cmd, process.execPath);
  assert.ok(isAbsolute(args[0]) && /vite\.js$/.test(args[0]));
  assert.deepEqual(args.slice(1), [
    '--config',
    'ai-analyzer/preview.static.config.mjs',
    '--port',
    '4105',
    '--host',
    '127.0.0.1',
  ]);
});
