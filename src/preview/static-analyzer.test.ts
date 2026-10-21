import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { injectAnalyzer } from './analyzer';

// injectAnalyzer's static branch: wrapper config written into the copied
// ai-analyzer folder, git-excluded, with the MPA + cacheDir guards that keep
// Vite artifacts out of a publish.

test('injectAnalyzer (static): wrapper config, git exclude, boot plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-static-an-'));
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');

  const boot = injectAnalyzer(dir);
  assert.deepEqual(boot, {
    framework: 'static',
    configPath: 'ai-analyzer/preview.static.config.mjs',
  });

  const wrapper = await readFile(
    join(dir, 'ai-analyzer/preview.static.config.mjs'),
    'utf8'
  );
  // MPA keeps /about serving about.html instead of an SPA fallback to index;
  // cacheDir keeps node_modules/.vite out of un-gitignored clones (publish
  // does git add -A).
  assert.match(wrapper, /appType: 'mpa'/);
  assert.match(wrapper, /cacheDir: 'ai-analyzer\/\.vite'/);
  assert.match(wrapper, /aiAnalyzerStatic/);
  // The static wrapper must stay import-free apart from its sibling plugin —
  // a bare `from 'vite'` cannot resolve from a clone without node_modules.
  assert.ok(!wrapper.includes("from 'vite'"));

  // The copied tagger files the wrapper references actually exist.
  for (const file of ['vite-plugin-static.mjs', 'annotate-html.mjs', 'overlay.js']) {
    await readFile(join(dir, 'ai-analyzer', file));
  }

  const exclude = await readFile(join(dir, '.git/info/exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('ai-analyzer/'));
});
