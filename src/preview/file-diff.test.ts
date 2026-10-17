import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'path';
import { IMAGE_PATH, isFullSha, parseNameStatus, resolveRepoPath } from './file-diff';

const dir = '/srv/workspace/123';

test('resolveRepoPath accepts a repo-relative path', () => {
  assert.equal(resolveRepoPath(dir, 'src/styles/global.css'), 'src/styles/global.css');
});

test('resolveRepoPath accepts an absolute path inside the clone', () => {
  assert.equal(
    resolveRepoPath(dir, join(dir, 'src/components/Header.astro')),
    'src/components/Header.astro'
  );
});

test('resolveRepoPath rejects traversal and foreign absolute paths', () => {
  assert.equal(resolveRepoPath(dir, '../../etc/passwd'), null);
  assert.equal(resolveRepoPath(dir, '/etc/passwd'), null);
  assert.equal(resolveRepoPath(dir, '/srv/workspace/124/src/index.astro'), null);
  assert.equal(resolveRepoPath(dir, 'src/../../x'), null);
});

test('resolveRepoPath rejects empty and the clone root itself', () => {
  assert.equal(resolveRepoPath(dir, ''), null);
  assert.equal(resolveRepoPath(dir, '   '), null);
  assert.equal(resolveRepoPath(dir, dir), null);
  assert.equal(resolveRepoPath(dir, '.'), null);
});

test('IMAGE_PATH matches raster + svg, not source files', () => {
  assert.ok(IMAGE_PATH.test('public/hero.WEBP'));
  assert.ok(IMAGE_PATH.test('src/assets/logo.svg'));
  assert.ok(!IMAGE_PATH.test('src/pages/index.astro'));
  assert.ok(!IMAGE_PATH.test('_pages.json'));
});

test('isFullSha requires 40 lowercase hex chars', () => {
  assert.ok(isFullSha('a'.repeat(40)));
  assert.ok(!isFullSha('a'.repeat(39)));
  assert.ok(!isFullSha('A'.repeat(40)));
  assert.ok(!isFullSha('HEAD'));
  assert.ok(!isFullSha('main..HEAD'));
});

test('parseNameStatus maps A/M/D and renames to the new path', () => {
  const out = [
    'M\tsrc/styles/global.css',
    'A\tsrc/components/Faq.astro',
    'D\tsrc/old.astro',
    'R087\tsrc/a.astro\tsrc/b.astro',
    '',
  ].join('\n');
  assert.deepEqual(parseNameStatus(out), [
    { path: 'src/styles/global.css', status: 'M' },
    { path: 'src/components/Faq.astro', status: 'A' },
    { path: 'src/old.astro', status: 'D' },
    { path: 'src/b.astro', status: 'R' },
  ]);
});

test('parseNameStatus returns [] for empty output', () => {
  assert.deepEqual(parseNameStatus(''), []);
  assert.deepEqual(parseNameStatus('\n\n'), []);
});
