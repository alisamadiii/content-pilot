import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectFramework,
  findAstroConfig,
  findNextConfig,
  findViteConfig,
} from './framework';

const app = async (opts: {
  files?: string[];
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  pkg?: string;
}) => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-fw-'));
  for (const f of opts.files ?? []) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), '');
  }
  if (opts.pkg !== undefined) {
    await writeFile(join(dir, 'package.json'), opts.pkg);
  } else if (opts.deps || opts.devDeps) {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: opts.deps ?? {}, devDependencies: opts.devDeps ?? {} })
    );
  }
  return dir;
};

test('config finders return the first name in precedence order, else null', async () => {
  const dir = await app({ files: ['astro.config.ts', 'astro.config.mjs', 'vite.config.js', 'next.config.mjs'] });
  assert.equal(findAstroConfig(dir), 'astro.config.mjs');
  assert.equal(findViteConfig(dir), 'vite.config.js');
  assert.equal(findNextConfig(dir), 'next.config.mjs');
  const empty = await app({});
  assert.equal(findAstroConfig(empty), null);
  assert.equal(findViteConfig(empty), null);
  assert.equal(findNextConfig(empty), null);
});

test('every supported config extension is recognised', async () => {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs']) {
    assert.equal(findAstroConfig(await app({ files: [name] })), name);
  }
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']) {
    assert.equal(findViteConfig(await app({ files: [name] })), name);
  }
  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']) {
    assert.equal(findNextConfig(await app({ files: [name] })), name);
  }
});

test('astro is detected by config file or by dependency', async () => {
  assert.equal(detectFramework(await app({ files: ['astro.config.mjs'] })), 'astro');
  assert.equal(detectFramework(await app({ deps: { astro: '^5' } })), 'astro');
  assert.equal(detectFramework(await app({ devDeps: { astro: '^5' } })), 'astro');
});

test('next is detected by config file or by dependency', async () => {
  assert.equal(detectFramework(await app({ files: ['next.config.ts'] })), 'next');
  assert.equal(detectFramework(await app({ deps: { next: '15' } })), 'next');
});

test('vite bucket: vite config, vite dep, or a TanStack Start dep', async () => {
  assert.equal(detectFramework(await app({ files: ['vite.config.ts'] })), 'vite');
  assert.equal(detectFramework(await app({ devDeps: { vite: '6' } })), 'vite');
  assert.equal(detectFramework(await app({ deps: { '@tanstack/react-start': '1' } })), 'vite');
  assert.equal(detectFramework(await app({ deps: { '@tanstack/start': '1' } })), 'vite');
});

test('precedence: astro beats next beats vite when several signals coexist', async () => {
  // Astro pulls in vite as a dep — must still be astro.
  assert.equal(detectFramework(await app({ deps: { astro: '5', vite: '6' }, files: ['vite.config.ts'] })), 'astro');
  assert.equal(detectFramework(await app({ deps: { next: '15', vite: '6' } })), 'next');
  assert.equal(detectFramework(await app({ files: ['astro.config.mjs', 'next.config.js'] })), 'astro');
});

test('unknown stacks and unreadable package.json yield null', async () => {
  assert.equal(detectFramework(await app({ deps: { react: '19' } })), null);
  assert.equal(detectFramework(await app({})), null);
  assert.equal(detectFramework(await app({ pkg: '{ not json' })), null);
  assert.equal(detectFramework(join(tmpdir(), 'cp-fw-does-not-exist')), null);
});
