import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPinnedFile,
  isStaleResumeError,
  looksLikeEdit,
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
  const block = await buildPinnedFile('source: src/x.astro:3', dir);
  assert.match(block, /src\/x\.astro/);
  assert.match(block, /line 3/);
  assert.match(block, /const stats = \[\{ target: 10 \}\]/);
  assert.match(block, /Do not read it again/);
});

test('buildPinnedFile returns empty when the file is missing or oversized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  assert.equal(await buildPinnedFile('source: src/missing.astro:1', dir), '');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/big.astro'), 'x'.repeat(40_001));
  assert.equal(await buildPinnedFile('source: src/big.astro:1', dir), '');
});

test('buildPinnedFile returns empty when there is no element ref and no routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  assert.equal(await buildPinnedFile('just a page edit', dir), '');
  assert.equal(await buildPinnedFile(null, dir), '');
});

const pageFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-pin-'));
  await mkdir(join(dir, 'src/pages'), { recursive: true });
  await mkdir(join(dir, 'src/components/about'), { recursive: true });
  await writeFile(join(dir, 'src/pages/index.astro'), '<h1>Home</h1>');
  await writeFile(
    join(dir, 'src/pages/about.astro'),
    '---\nimport Story from "@/components/about/story.astro";\n---\n<Story />'
  );
  await writeFile(join(dir, 'src/components/about/story.astro'), '<p>The person behind</p>');
  const routes = new Map([
    ['/', 'src/pages/index.astro'],
    ['/about', 'src/pages/about.astro'],
  ]);
  return { dir, routes };
};

test('buildPinnedFile pins the viewed page and its components when nothing was clicked', async () => {
  const { dir, routes } = await pageFixture();
  const block = await buildPinnedFile(
    'The client is editing this page: http://x.localhost:3020/about',
    dir,
    { message: 'change the intro', routes }
  );
  assert.match(block, /The client is viewing the page `\/about`, rendered by `src\/pages\/about\.astro`/);
  assert.match(block, /### src\/pages\/about\.astro/);
  assert.match(block, /### src\/components\/about\/story\.astro/);
  assert.match(block, /The person behind/);
  assert.match(block, /Do not read them again/);
});

test('buildPinnedFile prefers a page named in the message over the viewed one', async () => {
  const { dir, routes } = await pageFixture();
  const block = await buildPinnedFile(
    'The client is editing this page: http://x.localhost:3020/',
    dir,
    { message: 'add this image to the about page', routes }
  );
  assert.match(block, /The request is about the page `\/about`/);
  assert.doesNotMatch(block, /<h1>Home<\/h1>/);
});

test('buildPinnedFile pins the home page by default and the clicked file first', async () => {
  const { dir, routes } = await pageFixture();
  const home = await buildPinnedFile(null, dir, { message: 'change the title', routes });
  assert.match(home, /rendered by `src\/pages\/index\.astro`/);
  // Chat is not an edit request: nothing pinned.
  assert.equal(await buildPinnedFile(null, dir, { message: 'hi', routes }), '');
  assert.equal(await buildPinnedFile(null, dir, { message: 'thanks a lot, looks great', routes }), '');
  assert.equal(
    await buildPinnedFile(null, dir, {
      message: 'there is no need to read the agents.md file right now. Did you read it before the session',
      routes,
    }),
    ''
  );
  const clicked = await buildPinnedFile(
    'editing this page: http://x.localhost:3020/\nsource: src/components/about/story.astro:1',
    dir,
    { message: 'about page', routes }
  );
  assert.match(clicked, /clicked an element in `src\/components\/about\/story\.astro`/);
  assert.doesNotMatch(clicked, /### src\/pages/);
});

test('looksLikeEdit: edit verbs, corrections, quotes and attachments count; chat does not', () => {
  for (const yes of [
    'make it 3 wrods',
    'the phone number should be (904) 555-0199',
    'the title "Celebrating Afghan Heritage" please',
    'use "Celebrating Afghan Heritage" as the title',
    'there is a typo in the footer',
    'can you put a bigger photo there',
  ]) {
    assert.equal(looksLikeEdit(yes), true, yes);
  }
  assert.equal(looksLikeEdit('add this', true), true);
  assert.equal(looksLikeEdit('here you go', true), true);
  for (const no of [
    'hi',
    'thanks a lot, looks great',
    'did you read the agents file before the session',
    'what can you do for me?',
    'is the preview live now',
  ]) {
    assert.equal(looksLikeEdit(no), false, no);
  }
});

test('buildPinnedFile pins for an edit-like message or an attachment, never for chat', async () => {
  const { dir, routes } = await pageFixture();
  assert.match(
    await buildPinnedFile(null, dir, { message: 'the title should say Hello', routes }),
    /rendered by `src\/pages\/index\.astro`/
  );
  assert.match(
    await buildPinnedFile(null, dir, { message: 'this one', routes, hasAttachments: true }),
    /rendered by `src\/pages\/index\.astro`/
  );
  assert.equal(
    await buildPinnedFile(null, dir, { message: 'what can you do for me?', routes }),
    ''
  );
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
  assert.equal(pagePathFromContext('editing this page: team'), '/');
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
