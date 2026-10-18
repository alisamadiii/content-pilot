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

// ------------------------------------------------- image before/after (2026-10-18)

test('imageMime maps image extensions (any case) and rejects source files', async () => {
  const { imageMime } = await import('./file-diff');
  assert.equal(imageMime('public/images/uploads/2.webp'), 'image/webp');
  assert.equal(imageMime('a/B.JPG'), 'image/jpeg');
  assert.equal(imageMime('x.jpeg'), 'image/jpeg');
  assert.equal(imageMime('x.png'), 'image/png');
  assert.equal(imageMime('x.svg'), 'image/svg+xml');
  assert.equal(imageMime('x.ico'), 'image/x-icon');
  assert.equal(imageMime('src/pages/index.astro'), null);
  assert.equal(imageMime('noext'), null);
});

test('showImageAt returns a data URL for an image at a rev, null when absent, tooLarge above the cap', async () => {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const { mkdtemp, mkdir, writeFile } = await import('fs/promises');
  const { tmpdir } = await import('os');
  const { showImageAt, MAX_IMAGE_DIFF_BYTES } = await import('./file-diff');
  const run = promisify(execFile);
  const repo = await mkdtemp(join(tmpdir(), 'cp-imgdiff-'));
  const sh = async (args: string[]) => (await run('git', args, { cwd: repo })).stdout.trim();
  await sh(['init', '-q', '-b', 'main']);
  await mkdir(join(repo, 'public/images'), { recursive: true });
  // Tiny real-looking bytes incl. a NUL — anything binary-safe.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  await writeFile(join(repo, 'public/images/a.png'), png);
  await writeFile(join(repo, 'public/images/big.png'), Buffer.alloc(MAX_IMAGE_DIFF_BYTES + 1, 1));
  await sh(['add', '-A']);
  await sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'img']);
  const head = await sh(['rev-parse', 'HEAD']);

  const got = await showImageAt(repo, head, 'public/images/a.png');
  assert.ok(got && 'dataUrl' in got);
  assert.equal(got.dataUrl, `data:image/png;base64,${png.toString('base64')}`);

  assert.equal(await showImageAt(repo, head, 'public/images/missing.png'), null);
  assert.equal(await showImageAt(repo, head, 'src/index.astro'), null, 'non-image path → null');

  const big = await showImageAt(repo, head, 'public/images/big.png');
  assert.deepEqual(big, { tooLarge: true });
});
