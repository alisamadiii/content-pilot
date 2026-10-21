import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkFramework,
  detectFramework,
  findAstroConfig,
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
  const empty = await app({});
  assert.equal(findAstroConfig(empty), null);
  assert.equal(findViteConfig(empty), null);
});

test('every supported config extension is recognised', async () => {
  for (const name of ['astro.config.mjs', 'astro.config.ts', 'astro.config.mts', 'astro.config.js', 'astro.config.cjs']) {
    assert.equal(findAstroConfig(await app({ files: [name] })), name);
  }
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs']) {
    assert.equal(findViteConfig(await app({ files: [name] })), name);
  }
});

test('astro is detected by config file or by dependency', async () => {
  // A config file alone needs a package.json beside it (no package.json = the
  // static path, which requires index.html).
  assert.equal(detectFramework(await app({ files: ['astro.config.mjs'], deps: {} })), 'astro');
  assert.equal(detectFramework(await app({ deps: { astro: '^5' } })), 'astro');
  assert.equal(detectFramework(await app({ devDeps: { astro: '^5' } })), 'astro');
});

// DELIBERATE CHANGE (static-only pivot): Next.js and TanStack Start (SSR) are
// no longer supported frameworks — detectFramework returns null for them and
// checkFramework rejects them (see the checkFramework tests below).
test('next is rejected by config file or by dependency', async () => {
  assert.equal(detectFramework(await app({ files: ['next.config.ts'], deps: {} })), null);
  assert.equal(detectFramework(await app({ deps: { next: '15' } })), null);
});

test('vite bucket: vite config or vite dep', async () => {
  assert.equal(detectFramework(await app({ files: ['vite.config.ts'], deps: {} })), 'vite');
  assert.equal(detectFramework(await app({ devDeps: { vite: '6' } })), 'vite');
});

test('precedence: next is refused even beside astro/vite signals; astro beats vite', async () => {
  // Astro pulls in vite as a dep — must still be astro.
  assert.equal(detectFramework(await app({ deps: { astro: '5', vite: '6' }, files: ['vite.config.ts'] })), 'astro');
  assert.equal(detectFramework(await app({ deps: { next: '15', vite: '6' } })), null);
  assert.equal(detectFramework(await app({ files: ['astro.config.mjs', 'next.config.js'], deps: {} })), null);
});

test('unknown stacks and unreadable package.json yield null', async () => {
  assert.equal(detectFramework(await app({ deps: { react: '19' } })), null);
  assert.equal(detectFramework(await app({})), null);
  assert.equal(detectFramework(await app({ pkg: '{ not json' })), null);
  assert.equal(detectFramework(join(tmpdir(), 'cp-fw-does-not-exist')), null);
});

test('checkFramework accepts static HTML, Astro (with React/MDX islands) and Vite', async () => {
  assert.deepEqual(checkFramework(await app({ files: ['index.html'] })), { ok: true, framework: 'static' });
  assert.deepEqual(
    checkFramework(await app({ deps: { astro: '5', '@astrojs/react': '4', '@astrojs/mdx': '4', react: '19' } })),
    { ok: true, framework: 'astro' }
  );
  assert.deepEqual(checkFramework(await app({ devDeps: { vite: '6', '@vitejs/plugin-react': '4' } })), {
    ok: true,
    framework: 'vite',
  });
});

test('checkFramework rejects Next.js with a client-facing reason', async () => {
  const result = checkFramework(await app({ deps: { next: '15', react: '19' } }));
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'next');
  assert.match(!result.ok ? result.message : '', /Next\.js/);
});

test('checkFramework rejects Vite-based SSR meta-frameworks', async () => {
  for (const dep of ['@tanstack/react-start', '@sveltejs/kit', '@react-router/dev', 'nuxt']) {
    const result = checkFramework(await app({ deps: { [dep]: '1', vite: '6' } }));
    assert.equal(!result.ok && result.reason, 'ssr', dep);
  }
});

test("checkFramework rejects Astro with output: 'server' but accepts an adapter on static output", async () => {
  const server = await app({ deps: { astro: '5' } });
  await writeFile(join(server, 'astro.config.mjs'), "export default { output: 'server' };");
  assert.equal((r => !r.ok && r.reason)(checkFramework(server)), 'astro_server');

  const adapter = await app({ deps: { astro: '5', '@astrojs/cloudflare': '12' } });
  await writeFile(
    join(adapter, 'astro.config.mjs'),
    "import cloudflare from '@astrojs/cloudflare';\nexport default { adapter: cloudflare() };"
  );
  assert.deepEqual(checkFramework(adapter), { ok: true, framework: 'astro' });
});

test('checkFramework rejects unknown stacks and empty folders', async () => {
  assert.equal((r => !r.ok && r.reason)(checkFramework(await app({ deps: { react: '19' } }))), 'unknown');
  assert.equal((r => !r.ok && r.reason)(checkFramework(await app({}))), 'unknown');
});

test('unsupported messages never contain em dashes (shipped copy)', async () => {
  const { UNSUPPORTED_MESSAGES } = await import('./framework');
  for (const message of Object.values(UNSUPPORTED_MESSAGES)) {
    assert.equal(message.includes('\u2014'), false, message);
  }
});
