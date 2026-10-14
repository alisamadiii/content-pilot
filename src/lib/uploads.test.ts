import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTACHMENT_ID_PATTERN, newAttachmentId, sniffImage } from './uploads';

const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part
    )
  );

test('sniffImage recognises JPEG by its SOI marker', () => {
  assert.deepEqual(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')), {
    mime: 'image/jpeg',
  });
});

test('sniffImage recognises the 8-byte PNG signature', () => {
  assert.deepEqual(
    sniffImage(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a], 'IHDR')),
    { mime: 'image/png' }
  );
});

test('sniffImage recognises GIF87a and GIF89a', () => {
  assert.deepEqual(sniffImage(bytes('GIF87a', [0, 0])), { mime: 'image/gif' });
  assert.deepEqual(sniffImage(bytes('GIF89a', [0, 0])), { mime: 'image/gif' });
});

test('sniffImage recognises RIFF/WEBP', () => {
  assert.deepEqual(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')), {
    mime: 'image/webp',
  });
});

test('sniffImage rejects a RIFF container that is not WEBP (e.g. WAV)', () => {
  assert.deepEqual(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt ')), {
    reject: 'not-image',
  });
});

test('sniffImage rejects HEIC by its ftyp brand', () => {
  assert.deepEqual(sniffImage(bytes([0, 0, 0, 24], 'ftypheic', [0, 0, 0, 0])), {
    reject: 'heic',
  });
  assert.deepEqual(sniffImage(bytes([0, 0, 0, 24], 'ftypmif1', [0, 0, 0, 0])), {
    reject: 'heic',
  });
});

test('sniffImage treats an MP4 ftyp as not an image', () => {
  assert.deepEqual(sniffImage(bytes([0, 0, 0, 24], 'ftypisom', [0, 0, 0, 0])), {
    reject: 'not-image',
  });
});

test('sniffImage rejects SVG, with or without an XML prolog or BOM', () => {
  assert.deepEqual(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg">')), {
    reject: 'svg',
  });
  assert.deepEqual(sniffImage(bytes('<?xml version="1.0"?>\n<svg>')), {
    reject: 'svg',
  });
  assert.deepEqual(sniffImage(bytes([0xef, 0xbb, 0xbf], '  <svg>')), {
    reject: 'svg',
  });
});

test('sniffImage treats plain text and empty input as not an image', () => {
  assert.deepEqual(sniffImage(bytes('hello world')), { reject: 'not-image' });
  assert.deepEqual(sniffImage(new Uint8Array()), { reject: 'not-image' });
});

test('newAttachmentId yields 10 lowercase alphanumerics', () => {
  for (let i = 0; i < 20; i++) {
    assert.match(newAttachmentId(), ATTACHMENT_ID_PATTERN);
  }
});
