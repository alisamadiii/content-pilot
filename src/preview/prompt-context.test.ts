import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPinnedFile,
  isStaleResumeError,
  pagePathFromContext,
  parseSourceRef,
} from './prompt-context';

const ELEMENT_CONTEXT =
  'The client is editing this page: http://x.localhost:3020/about\n' +
  'They clicked an element — source: src/components/landing-page/impact.astro:53\n' +
  'Element content: "10"\n' +
  'Focus the change on that element; do not search the rest of the repo unless needed.';

test('parseSourceRef pulls path + line from the element context', () => {
  assert.deepEqual(parseSourceRef(ELEMENT_CONTEXT), {
    path: 'src/components/landing-page/impact.astro',
    line: 53,
  });
});

test('parseSourceRef strips a leading <project>: prefix', () => {
  assert.deepEqual(
    parseSourceRef('source: myproject:src/pages/index.astro:12'),
    { path: 'src/pages/index.astro', line: 12 }
  );
});

test('parseSourceRef handles a ref with no line number', () => {
  assert.deepEqual(parseSourceRef('source: src/foo.astro'), {
    path: 'src/foo.astro',
    line: null,
  });
});

test('parseSourceRef rejects path traversal and empty/no ref', () => {
  assert.equal(parseSourceRef('source: ../../etc/passwd:1'), null);
  assert.equal(parseSourceRef('no ref here'), null);
  assert.equal(parseSourceRef(null), null);
});

test('buildPinnedFile inlines the clicked file content with a hard directive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/x.astro'), 'const stats = [{ target: 10 }]');
  const block = await buildPinnedFile('source: src/x.astro:3', dir, dir);
  assert.match(block, /src\/x\.astro/);
  assert.match(block, /line 3/);
  assert.match(block, /const stats = \[\{ target: 10 \}\]/);
  assert.match(block, /Do not read it again/);
});

test('buildPinnedFile returns empty when the file is missing or oversized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  assert.equal(await buildPinnedFile('source: src/missing.astro:1', dir, dir), '');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/big.astro'), 'x'.repeat(40_001));
  assert.equal(await buildPinnedFile('source: src/big.astro:1', dir, dir), '');
});

test('buildPinnedFile returns empty when there is no element ref', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  assert.equal(await buildPinnedFile('just a page edit', dir, dir), '');
  assert.equal(await buildPinnedFile(null, dir, dir), '');
});

test('pagePathFromContext extracts the pathname from the page url', () => {
  assert.equal(pagePathFromContext(ELEMENT_CONTEXT), '/about');
  assert.equal(
    pagePathFromContext('editing this page: http://x.localhost:3020/'),
    '/'
  );
});

test('pagePathFromContext falls back to / when absent or unparseable', () => {
  assert.equal(pagePathFromContext(null), '/');
  assert.equal(pagePathFromContext('no page here'), '/');
  assert.equal(pagePathFromContext('editing this page: /team'), '/team');
});

test('isStaleResumeError matches Claude and Gemini resume-failure phrasings', () => {
  assert.equal(isStaleResumeError('No conversation found for this session'), true);
  assert.equal(
    isStaleResumeError(
      'Error resuming session: No previous sessions found for this project.'
    ),
    true
  );
  assert.equal(isStaleResumeError('checkpoint not found'), true);
  assert.equal(isStaleResumeError('the session has expired'), true);
});

test('isStaleResumeError ignores unrelated errors', () => {
  assert.equal(isStaleResumeError('Rate limit exceeded'), false);
  assert.equal(isStaleResumeError('is no longer valid JSON'), false);
  assert.equal(isStaleResumeError(''), false);
});
