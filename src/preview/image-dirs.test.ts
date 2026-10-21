import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { IMAGE_FILE, listImageDirHints } from './image-dirs';

// slugify / chooseImageDir are covered in attachments.test.ts.

const seed = async (files: string[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-imgdirs-'));
  for (const f of files) {
    await mkdir(join(dir, f, '..'), { recursive: true });
    await writeFile(join(dir, f), 'x');
  }
  return dir;
};

test('IMAGE_FILE matches the stored + svg/avif extensions, case-insensitively, nothing else', () => {
  for (const ok of ['a.webp', 'b.JPG', 'c.jpeg', 'd.png', 'e.gif', 'f.avif', 'g.svg']) assert.ok(IMAGE_FILE.test(ok), ok);
  for (const no of ['a.webp.bak', 'b.heic', 'c.mp4', 'd.json', 'png']) assert.ok(!IMAGE_FILE.test(no), no);
});

test('counts images per folder under public/ and src/, sorted by count then name', async () => {
  const dir = await seed([
    'public/images/team/a.webp',
    'public/images/team/b.webp',
    'public/images/team/c.jpg',
    'public/images/hero.png',
    'public/images/notes.txt',
    'src/assets/x.jpg',
    'src/assets/y.jpg',
    'src/assets/z.jpg',
  ]);
  assert.deepEqual(await listImageDirHints(dir, 'public'), [
    { dir: 'public/images/team', count: 3 },
    { dir: 'src/assets', count: 3 },
    { dir: 'public/images', count: 1 },
  ]);
});

test('dot folders, node_modules, dist and build are skipped; depth is bounded at 4', async () => {
  const dir = await seed([
    'public/.cache/a.png',
    'public/node_modules/pkg/b.png',
    'public/dist/c.png',
    'public/build/d.png',
    'public/a/b/c/d/deep.png', // depth 4 → counted
    'public/a/b/c/d/e/toodeep.png', // depth 5 → skipped
  ]);
  assert.deepEqual(await listImageDirHints(dir, 'public'), [
    { dir: 'public/a/b/c/d', count: 1 },
  ]);
});

// DELIBERATE CHANGE (root-only sites): app-folder override removed; the
// subfolder-prefix case went with it.

test('result is capped at the top 20 folders', async () => {
  const files: string[] = [];
  for (let i = 0; i < 25; i++) files.push(`public/f${String(i).padStart(2, '0')}/a.png`);
  files.push('public/big/a.png', 'public/big/b.png');
  const dir = await seed(files);
  const hints = await listImageDirHints(dir, 'public');
  assert.equal(hints.length, 20);
  assert.deepEqual(hints[0], { dir: 'public/big', count: 2 });
  assert.equal(hints[1].dir, 'public/f00');
});

test('a missing site dir yields an empty list instead of throwing', async () => {
  assert.deepEqual(await listImageDirHints(join(tmpdir(), 'cp-imgdirs-missing'), 'public'), []);
});
