import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { chooseImageDir, listImageDirHints } from './image-dirs';

// Image placement for static repos (empty publicRel — assets served from the
// repo root, no public/ folder). The public/-convention paths stay covered by
// image-dirs.test.ts.

test('listImageDirHints walks root image folders when there is no public/', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-imgdirs-'));
  for (const file of ['images/team/a.webp', 'images/team/b.webp', 'assets/logo.svg']) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), '');
  }
  const hints = await listImageDirHints(dir, '');
  assert.deepEqual(hints, [
    { dir: 'images/team', count: 2 },
    { dir: 'assets', count: 1 },
  ]);
});

test('chooseImageDir with empty publicRel: matching root folder wins', () => {
  const hints = [
    { dir: 'images/team', count: 2 },
    { dir: 'images/projects', count: 5 },
  ];
  assert.equal(chooseImageDir('new team photo', hints, ''), 'images/team');
});

test('chooseImageDir with empty publicRel: default has no leading slash', () => {
  assert.equal(chooseImageDir('misc banner', [], ''), 'images/uploads');
});
