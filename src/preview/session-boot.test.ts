import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { previewConfig } from './config';
import {
  allowedHostSuffix,
  assertSiteRoot,
  depsHash,
  devCommand,
  hasDevScript,
  INSTALL_HASH_MARKER,
  INSTALL_SCHEME,
  installMarker,
  installUpToDate,
  NO_SITE_MESSAGE,
  publicEndpoint,
  salientError,
  userCodeEnv,
} from './session-boot';

const repo = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-boot-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
};

// ---------------------------------------------------------------- site root

// DELIBERATE CHANGE (root-only sites): the app-folder override and its config
// error are gone; the folder finder became assertSiteRoot. The
// override/subfolder cases were removed; root cases kept below.

test('assertSiteRoot: root package.json passes', async () => {
  const dir = await repo({ 'package.json': '{}', 'site/package.json': '{}' });
  assert.doesNotThrow(() => assertSiteRoot(dir));
});

test('assertSiteRoot never looks in subfolders: no root package.json is a plain client-facing error', async () => {
  const dir = await repo({ 'site/package.json': '{}' });
  assert.throws(
    () => assertSiteRoot(dir),
    (e: unknown) =>
      e instanceof Error &&
      e.message === NO_SITE_MESSAGE &&
      /root of this project/.test(e.message) &&
      !e.message.includes('—')
  );
});

// Regression (2026-10-21, root-only sites): empty root throws, index.html-only
// and package.json-only roots pass.
test('assertSiteRoot: empty dir throws; index.html-only and package.json-only roots pass', async () => {
  const empty = await repo({});
  assert.throws(() => assertSiteRoot(empty), /couldn't find a site at the root/);
  const html = await repo({ 'index.html': '<h1>hi</h1>' });
  assert.doesNotThrow(() => assertSiteRoot(html));
  const pkg = await repo({ 'package.json': '{}' });
  assert.doesNotThrow(() => assertSiteRoot(pkg));
});

// ------------------------------------------------------------- install cache

test('depsHash prefers package-lock.json over package.json and is content-stable', async () => {
  const a = await repo({ 'package.json': '{"a":1}', 'package-lock.json': 'LOCK' });
  const b = await repo({ 'package.json': '{"b":2}', 'package-lock.json': 'LOCK' });
  const c = await repo({ 'package.json': '{"a":1}' });
  const d = await repo({ 'package.json': '{"a":1}' });
  assert.equal(depsHash(a), depsHash(b), 'same lock, different package.json → same hash');
  assert.notEqual(depsHash(a), depsHash(c), 'lock vs package.json differ');
  assert.equal(depsHash(c), depsHash(d));
  assert.equal(depsHash(await repo({})), null);
});

test('installMarker tags the hash with the install scheme so a scheme change forces a reinstall', async () => {
  const dir = await repo({ 'package.json': '{}' });
  assert.equal(INSTALL_SCHEME, 'incdev');
  assert.equal(installMarker(dir), `${depsHash(dir)}:incdev`);
  assert.equal(installMarker(await repo({})), null);
  assert.equal(INSTALL_HASH_MARKER, join('node_modules', '.cp-install-hash'));
});

test('installUpToDate only when node_modules exists and the marker matches exactly', async () => {
  const dir = await repo({ 'package.json': '{}' });
  const marker = installMarker(dir)!;
  assert.equal(installUpToDate(dir, marker), false, 'cold: no node_modules');
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  assert.equal(installUpToDate(dir, marker), false, 'warm but no marker file');
  await writeFile(join(dir, INSTALL_HASH_MARKER), `${marker}\n`);
  assert.equal(installUpToDate(dir, marker), true, 'marker matches (trailing newline tolerated)');
  assert.equal(installUpToDate(dir, `${marker}x`), false, 'deps changed');
  assert.equal(installUpToDate(dir, null), false, 'nothing to hash → always install');
});

// ----------------------------------------------------------- dev server cmd

test('hasDevScript reads scripts.dev and tolerates a missing/invalid package.json', async () => {
  assert.equal(hasDevScript(await repo({ 'package.json': '{"scripts":{"dev":"astro dev"}}' })), true);
  assert.equal(hasDevScript(await repo({ 'package.json': '{"scripts":{"build":"x"}}' })), false);
  assert.equal(hasDevScript(await repo({ 'package.json': 'nope' })), false);
  assert.equal(hasDevScript(await repo({})), false);
});

test('astro: wrapper config, pinned root, foreground flag; via npm run dev when a script exists', async () => {
  const withScript = await repo({ 'package.json': '{"scripts":{"dev":"astro dev --port 9999"}}' });
  const boot = { framework: 'astro' as const, configPath: 'ai-analyzer/preview.config.mjs' };
  assert.deepEqual(devCommand(withScript, 4101, boot), {
    cmd: 'npm',
    args: ['run', 'dev', '--', '--config', 'ai-analyzer/preview.config.mjs', '--root', '.', '--port', '4101', '--host', '127.0.0.1', '--ignore-lock'],
    env: {},
  });
  const noScript = await repo({ 'package.json': '{}' });
  assert.deepEqual(devCommand(noScript, 4101, boot).cmd, 'npx');
  assert.deepEqual(devCommand(noScript, 4101, boot).args.slice(0, 2), ['astro', 'dev']);
});

// DELIBERATE CHANGE (static-only pivot): the Next.js boot path and the
// unrecognized-framework plain-boot fallback were removed — unsupported
// projects are refused at import/start, so devCommand always has a BootPlan.
test('vite always runs the binary directly (client dev scripts fight the port)', async () => {
  const dir = await repo({ 'package.json': '{"scripts":{"dev":"vite --port 1"}}' });
  assert.deepEqual(devCommand(dir, 4102, { framework: 'vite', configPath: 'ai-analyzer/preview.vite.config.mjs' }), {
    cmd: 'npx',
    args: ['vite', 'dev', '--config', 'ai-analyzer/preview.vite.config.mjs', '--port', '4102', '--host', '127.0.0.1'],
    env: {},
  });
});

// ------------------------------------------------------------ public endpoint

test('allowedHostSuffix + publicEndpoint derive from PREVIEW_URL_BASE', () => {
  const original = previewConfig.urlBase;
  try {
    previewConfig.urlBase = 'https://{id}.preview.example.com';
    assert.equal(allowedHostSuffix(), '.preview.example.com');
    assert.deepEqual(publicEndpoint(), { protocol: 'https', port: '443' });
    previewConfig.urlBase = 'http://{id}.localhost:3020';
    assert.equal(allowedHostSuffix(), '.localhost');
    assert.deepEqual(publicEndpoint(), { protocol: 'http', port: '3020' });
    previewConfig.urlBase = 'http://{id}.example.org';
    assert.deepEqual(publicEndpoint(), { protocol: 'http', port: '80' });
    previewConfig.urlBase = 'not a url';
    assert.equal(allowedHostSuffix(), '.localhost');
    assert.deepEqual(publicEndpoint(), { protocol: 'http', port: '80' });
  } finally {
    previewConfig.urlBase = original;
  }
});

// -------------------------------------------------------------- error salience

test('salientError prefers the specific cause over the generic wrapper and stack frames', () => {
  const tail = [
    'Unable to load src/content/config.ts',
    '  at loadConfig (file:///x.js:1:1)',
    'Error: Cannot find module "astro:content"',
    '  at Module._resolveFilename (node:internal/modules:1:1)',
    'Cannot send non-custom events',
  ].join('\n');
  assert.equal(salientError(tail), 'Error: Cannot find module "astro:content"');
});

test('salientError joins a wrapper line with the next meaningful line when no cause matches', () => {
  const tail = 'Unable to load X\n  at foo (a.js:1:1)\nsomething odd happened\nlast line';
  assert.equal(salientError(tail), 'Unable to load X — something odd happened');
  assert.equal(salientError('could not resolve Y'), 'could not resolve Y');
});

test('salientError falls back to the last 300 chars of the raw tail', () => {
  const tail = 'a'.repeat(500) + 'END';
  assert.equal(salientError(tail), ('a'.repeat(500) + 'END').slice(-300));
  assert.equal(salientError(''), '');
});

test('salientError caps a matched line at 400 chars', () => {
  const line = 'SyntaxError: ' + 'x'.repeat(1000);
  assert.equal(salientError(line).length, 400);
});

test('userCodeEnv passes only the allow-list, never pilot secrets', () => {
  const env = userCodeEnv(
    { NODE_ENV: 'development' },
    {
      PATH: '/usr/bin',
      HOME: '/home/app',
      DATABASE_URL: 'postgres://secret',
      GITHUB_APP_PRIVATE_KEY: 'k',
      BETTER_AUTH_SECRET: 's',
      ANTHROPIC_API_KEY: 'a',
      GEMINI_API_KEY: 'g',
      EDIT_TOKEN_SECRET: 'e',
    } as unknown as NodeJS.ProcessEnv
  );
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/app', NODE_ENV: 'development' });
});
