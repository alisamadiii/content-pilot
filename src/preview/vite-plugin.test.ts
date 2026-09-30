import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiAnalyzerVite } from '../../ai-analyzer/vite-plugin.mjs';

// Regression guard for the query'd-virtual-module bug: Astro extracts <script>/
// <style> blocks as sub-modules with a query (Hero.astro?astro&type=script&lang.ts).
// Matching those (by stripping the query) spliced data-cms-src into raw TS such as
// `ReturnType<typeof setInterval>` and broke the build. The plugin must match only
// the primary bare-path module.
const mkPlugin = () =>
  aiAnalyzerVite({
    astroAnnotator: async (src: string, o: { srcPath: string }) =>
      `${src} [ASTRO ${o.srcPath}]`,
  } as Record<string, unknown>);

type Handler = (source: string, id: string) => Promise<{ code: string } | null>;
const handlerOf = (p: ReturnType<typeof aiAnalyzerVite>): Handler =>
  (p.transform as { handler: Handler }).handler;

test('query-suffixed astro sub-module (extracted script) is skipped', async () => {
  const out = await handlerOf(mkPlugin())(
    'let heroTimer: ReturnType<typeof setInterval> | undefined;',
    '/proj/src/components/Hero.astro?astro&type=script&index=0&lang.ts'
  );
  assert.equal(out, null);
});

test('a real .astro file is annotated', async () => {
  const out = await handlerOf(mkPlugin())('<p>hi</p>', '/proj/src/Hero.astro');
  assert.ok(out && out.code.includes('[ASTRO'));
});

test('query-suffixed tsx (HMR re-request) is skipped', async () => {
  const out = await handlerOf(mkPlugin())('const A = () => <p>x</p>;', '/proj/src/a.tsx?t=123');
  assert.equal(out, null);
});

test('a real .tsx file is annotated with data-cms-src', async () => {
  const out = await handlerOf(mkPlugin())(
    'export const A = () => <p>x</p>;',
    '/proj/src/a.tsx'
  );
  assert.ok(out && /data-cms-src/.test(out.code));
});

test('node_modules is never annotated', async () => {
  const out = await handlerOf(mkPlugin())(
    'export const A = () => <p>x</p>;',
    '/proj/node_modules/pkg/a.tsx'
  );
  assert.equal(out, null);
});

test('.astro is skipped when no astro annotator is provided (non-Astro Vite)', async () => {
  const out = await (aiAnalyzerVite({}).transform as { handler: Handler }).handler(
    '<p>hi</p>',
    '/proj/src/Hero.astro'
  );
  assert.equal(out, null);
});
