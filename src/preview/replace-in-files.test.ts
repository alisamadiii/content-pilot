import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describeReplace, MAX_FILES, replaceInFiles } from './replace-in-files';

const site = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-replace-'));
  await mkdir(join(dir, 'src/components'), { recursive: true });
  await mkdir(join(dir, 'src/pages'), { recursive: true });
  await mkdir(join(dir, 'src/styles'), { recursive: true });
  await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
  await writeFile(join(dir, 'src/styles/global.css'), ':root{--brand:#1554A8;}');
  await writeFile(join(dir, 'src/components/Header.astro'), '<a style="color:#1554A8">x</a>');
  await writeFile(join(dir, 'src/pages/index.astro'), '<p>#1554A8 and #1554A8</p>');
  await writeFile(join(dir, 'src/pages/about.astro'), '<p>nothing here</p>');
  await writeFile(join(dir, 'node_modules/pkg/x.css'), '#1554A8');
  await writeFile(join(dir, 'package.json'), '{"name":"#1554A8"}');
  await writeFile(join(dir, '.env'), 'KEY=#1554A8');
  return dir;
};

test('replaceInFiles swaps a literal across files, skipping node_modules + forbidden paths', async () => {
  const dir = await site();
  const result = replaceInFiles({ dir, find: '#1554A8', replace: '#5B21B6' });
  assert.ok(result.ok);
  assert.deepEqual(
    result.files.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'src/components/Header.astro', count: 1 },
      { path: 'src/pages/index.astro', count: 2 },
      { path: 'src/styles/global.css', count: 1 },
    ]
  );
  assert.equal(result.total, 4);
  assert.equal(await readFile(join(dir, 'src/pages/index.astro'), 'utf8'), '<p>#5B21B6 and #5B21B6</p>');
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), '{"name":"#1554A8"}');
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'KEY=#1554A8');
  assert.equal(await readFile(join(dir, 'node_modules/pkg/x.css'), 'utf8'), '#1554A8');
});

test('replaceInFiles is literal and case-sensitive', async () => {
  const dir = await site();
  const result = replaceInFiles({ dir, find: '#1554a8', replace: 'x' });
  assert.ok(result.ok);
  assert.equal(result.files.length, 0);
  const dot = replaceInFiles({ dir, find: '.1554A8', replace: 'x' });
  assert.ok(dot.ok);
  assert.equal(dot.files.length, 0);
});

test('replaceInFiles honours include path fragments', async () => {
  const dir = await site();
  const result = replaceInFiles({ dir, find: '#1554A8', replace: '#000', include: ['src/pages'] });
  assert.ok(result.ok);
  assert.deepEqual(result.files, [{ path: 'src/pages/index.astro', count: 2 }]);
  assert.equal(await readFile(join(dir, 'src/styles/global.css'), 'utf8'), ':root{--brand:#1554A8;}');
});

test('replaceInFiles refuses short needles and identical find/replace without writing', async () => {
  const dir = await site();
  const short = replaceInFiles({ dir, find: '#1', replace: '#2' });
  assert.ok(!short.ok);
  const same = replaceInFiles({ dir, find: '#1554A8', replace: '#1554A8' });
  assert.ok(!same.ok);
  assert.equal(await readFile(join(dir, 'src/styles/global.css'), 'utf8'), ':root{--brand:#1554A8;}');
});

test('replaceInFiles refuses when too many files match, leaving every file untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-replace-'));
  for (let i = 0; i <= MAX_FILES; i++) {
    await writeFile(join(dir, `f${i}.txt`), 'brand brand');
  }
  const result = replaceInFiles({ dir, find: 'brand', replace: 'x' });
  assert.ok(!result.ok);
  assert.match(result.error, /more than 40/);
  assert.equal(await readFile(join(dir, 'f0.txt'), 'utf8'), 'brand brand');
});

test('replaceInFiles refuses a file with too many hits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-replace-'));
  await writeFile(join(dir, 'big.txt'), 'abc '.repeat(201));
  const result = replaceInFiles({ dir, find: 'abc', replace: 'x' });
  assert.ok(!result.ok);
  assert.match(result.error, /more than 200/);
});

test('replaceInFiles dryRun counts without writing', async () => {
  const dir = await site();
  const result = replaceInFiles({ dir, find: '#1554A8', replace: '#000', dryRun: true });
  assert.ok(result.ok);
  assert.equal(result.total, 4);
  assert.equal(await readFile(join(dir, 'src/styles/global.css'), 'utf8'), ':root{--brand:#1554A8;}');
});

test('describeReplace lists files for the model', () => {
  assert.equal(
    describeReplace({ ok: true, total: 3, files: [{ path: 'a.css', count: 1 }, { path: 'b.astro', count: 2 }] }),
    'Replaced 3 occurrences in 2 files:\n- a.css (1)\n- b.astro (2)'
  );
  assert.equal(describeReplace({ ok: true, total: 0, files: [] }), 'No files contain that text. Nothing changed.');
  assert.equal(describeReplace({ ok: false, error: 'why' }), 'No changes made. why');
});
