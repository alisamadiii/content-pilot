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

test('replaceInFiles: prose rename leaves routes, filenames, keys and attribute paths alone (EmpowerHer "Mentorship → Mentoring everywhere")', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-replace-ident-'));
  await mkdir(join(dir, 'src/components'), { recursive: true });
  await mkdir(join(dir, '.claude/skills/x'), { recursive: true });
  await mkdir(join(dir, 'cms'), { recursive: true });
  await writeFile(join(dir, 'src/components/Nav.astro'), [
    '<a href="/mentorship" class="mentorship-link">Mentorship Program</a>',
    '<img src="https://cdn.x/mentorship-hero.jpeg" alt="Mentorship" />',
    '<p>Through mentorship and care. Mentorship matters.</p>',
    '// Ports components/marketing/mentorship/hero.tsx',
  ].join('\n'));
  await writeFile(join(dir, '_site.json'), '{"mentorship": {"title": "Mentorship Program", "route": "/mentorship"}}');
  await writeFile(join(dir, '.claude/skills/x/SKILL.md'), 'Mentorship page skill');
  await writeFile(join(dir, 'AGENTS.md'), '| Mentorship workshops |');
  await writeFile(join(dir, 'cms/workshops.yml'), 'description: Mentorship page');
  const r1 = replaceInFiles({ dir, find: 'Mentorship', replace: 'Mentoring' });
  const r2 = replaceInFiles({ dir, find: 'mentorship', replace: 'mentoring' });
  assert.ok(r1.ok && r2.ok);
  assert.equal(await readFile(join(dir, 'src/components/Nav.astro'), 'utf8'), [
    '<a href="/mentorship" class="mentorship-link">Mentoring Program</a>',
    '<img src="https://cdn.x/mentorship-hero.jpeg" alt="Mentoring" />',
    '<p>Through mentoring and care. Mentoring matters.</p>',
    '// Ports components/marketing/mentorship/hero.tsx',
  ].join('\n'));
  assert.equal(await readFile(join(dir, '_site.json'), 'utf8'), '{"mentorship": {"title": "Mentoring Program", "route": "/mentorship"}}');
  // Developer files untouched.
  assert.equal(await readFile(join(dir, '.claude/skills/x/SKILL.md'), 'utf8'), 'Mentorship page skill');
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '| Mentorship workshops |');
  assert.equal(await readFile(join(dir, 'cms/workshops.yml'), 'utf8'), 'description: Mentorship page');
});

test('isIdentifierContext / proseOccurrences: glued-to-path or key positions are code, spaced words are prose', async () => {
  const { isIdentifierContext, proseOccurrences } = await import('./replace-in-files');
  const text = 'see /mentorship and mentorship.astro and "mentorship": 1 and our mentorship program';
  const positions = proseOccurrences(text, 'mentorship');
  assert.deepEqual(positions.map((p) => text.slice(p - 1, p + 10)), [' mentorship']);
  assert.ok(isIdentifierContext('x-mentorship', 2, 10));
  assert.ok(!isIdentifierContext('a mentorship b', 2, 10));
});

test('describeReplace: reports occurrences deliberately left inside links/filenames/keys so the model stops hunting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-replace-skipped-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/Nav.astro'), '<a href="/mentorship">Mentorship</a> and /mentorship again');
  const result = replaceInFiles({ dir, find: 'Mentorship', replace: 'Mentoring' });
  assert.ok(result.ok);
  assert.equal(result.total, 1);
  assert.equal(result.skippedIdentifiers, 0, 'case-sensitive: lowercase /mentorship is a different needle');
  const lower = replaceInFiles({ dir, find: 'mentorship', replace: 'mentoring' });
  assert.ok(lower.ok);
  assert.equal(lower.total, 0);
  assert.equal(lower.skippedIdentifiers, 2);
  assert.match(describeReplace(lower), /No prose contains that text\. Nothing changed\. Left 2 occurrences inside links, file names or data keys unchanged on purpose/);
  assert.match(describeReplace(result), /^Replaced 1 occurrence in 1 file:/);
});
