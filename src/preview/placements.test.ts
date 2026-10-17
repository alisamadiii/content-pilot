import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAttachmentsBlock,
  MENTION_SCAN_MAX_BYTES,
  verifyPlacements,
  type AttachmentRow,
  type Placed,
} from './placements';

const row = (over: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'abcdefghij',
  sessionId: 's',
  messageId: 1,
  originalName: 'IMG_0001.jpg',
  mime: 'image/webp',
  bytes: 10,
  width: 800,
  height: 600,
  description: 'Team photo',
  stagedPath: 's/abcdefghij.webp',
  placedPath: null,
  createdAt: new Date(0),
  ...over,
});

const placed = (url: string, over: Partial<AttachmentRow> = {}): Placed => ({
  row: row(over),
  dest: `public${url}`,
  url,
});

test('attachments block: singular wording, ext from mime, size, description', () => {
  const block = buildAttachmentsBlock([placed('/images/team/team-photo.webp')]);
  assert.match(block, /attached 1 image to this request\. The server has already saved it into the site at the URL path below/);
  assert.match(block, /1\. `\/images\/team\/team-photo\.webp` \(webp, 800 x 600\)\. Description: Team photo/);
  assert.match(block, /<img src="\/images\/team\/team-photo\.webp" alt="\.\.\.">/);
  assert.match(block, /Do NOT open, read, view or search for image files/);
});

test('attachments block: plural wording, numbered list, example uses the first url', () => {
  const block = buildAttachmentsBlock([
    placed('/a.webp'),
    placed('/b.jpg', { mime: 'image/jpeg', description: '', width: 10, height: 20 }),
  ]);
  assert.match(block, /attached 2 images to this request\. The server has already saved them into the site at the URL paths below/);
  assert.match(block, /1\. `\/a\.webp` \(webp/);
  assert.match(block, /2\. `\/b\.jpg` \(jpg, 10 x 20\)\. Description: \(none given\)/);
  assert.match(block, /<img src="\/a\.webp"/);
});

const repo = async (files: Record<string, string | Buffer>) => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-place-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
};

test('verifyPlacements passes when a changed text file references the url (with or without leading slash)', async () => {
  const dir = await repo({
    'src/pages/index.astro': '<img src="/images/a.webp">',
    '_site.json': '{"hero":"images/b.webp"}',
  });
  assert.equal(
    await verifyPlacements({
      dir,
      placed: [placed('/images/a.webp'), placed('/images/b.webp')],
      changed: ['src/pages/index.astro', '_site.json'],
    }),
    null
  );
});

test('verifyPlacements reports every unreferenced image, description or filename as the label', async () => {
  const dir = await repo({ 'src/pages/index.astro': '<h1>hi</h1>' });
  const out = await verifyPlacements({
    dir,
    placed: [placed('/images/a.webp'), placed('/images/b.webp', { description: '', originalName: 'photo.jpg' })],
    changed: ['src/pages/index.astro'],
  });
  assert.equal(
    out,
    'The image at `/images/a.webp` (Team photo) is not referenced anywhere. Add it to the component or CMS JSON.\n' +
      'The image at `/images/b.webp` (photo.jpg) is not referenced anywhere. Add it to the component or CMS JSON.'
  );
});

test('verifyPlacements ignores image files, oversized files and missing files in the changed list', async () => {
  const CAP = 2 * 1024 * 1024;
  assert.equal(MENTION_SCAN_MAX_BYTES, CAP);
  const big = Buffer.alloc(CAP + 1, ' ');
  big.write('/images/a.webp', 0);
  const dir = await repo({
    'public/images/a.webp': '/images/a.webp', // the image itself "mentions" its url
    'huge.txt': big,
  });
  const out = await verifyPlacements({
    dir,
    placed: [placed('/images/a.webp')],
    changed: ['public/images/a.webp', 'huge.txt', 'deleted.astro'],
  });
  assert.match(out ?? '', /\/images\/a\.webp.*not referenced/);
  // Exactly at the cap is still scanned.
  const atCap = Buffer.alloc(CAP, ' ');
  atCap.write('/images/a.webp', 0);
  const dir2 = await repo({ 'ok.txt': atCap });
  assert.equal(await verifyPlacements({ dir: dir2, placed: [placed('/images/a.webp')], changed: ['ok.txt'] }), null);
});

test('verifyPlacements with nothing placed is always fine', async () => {
  assert.equal(await verifyPlacements({ dir: '/nonexistent', placed: [], changed: ['x'] }), null);
});
