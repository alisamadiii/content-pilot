import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractZip, safeEntryPath, stripWrapperDir, ZipError, ZIP_LIMITS } from './zip-extract';

// Hand-built stored (uncompressed) zips so the hostile shapes — ../ paths,
// absolute paths, symlink modes — can actually be produced; archiver CLIs
// refuse to write them.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

interface ZipEntry {
  name: string;
  data?: string;
  /** Unix mode for the central-directory external attributes (e.g. 0o120777 symlink). */
  mode?: number;
}

/** Minimal stored-method zip writer: local headers + central dir + EOCD. */
const makeZip = (entries: ZipEntry[]): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '', 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(0, 10); // dos time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
};

const scratch = () => mkdtempSync(join(tmpdir(), 'cp-zip-'));

const writeZip = (entries: ZipEntry[]) => {
  const dir = scratch();
  const zipPath = join(dir, 'in.zip');
  writeFileSync(zipPath, makeZip(entries));
  return { zipPath, dest: join(dir, 'out') };
};

test('extracts regular files preserving nested paths', async () => {
  const { zipPath, dest } = writeZip([
    { name: 'index.html', data: '<h1>hi</h1>' },
    { name: 'css/style.css', data: 'body{}' },
  ]);
  const { files } = await extractZip(zipPath, dest);
  assert.equal(files, 2);
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.equal(readFileSync(join(dest, 'css', 'style.css'), 'utf8'), 'body{}');
});

test('zip-slip archives (.. or absolute entries) are rejected whole', async () => {
  // yauzl hard-errors the archive on `..`/absolute names; extractZip maps
  // that to a client-facing ZipError. Nothing is written for the good entry
  // either — a hostile zip is refused entirely.
  for (const name of ['../evil.txt', 'a/../../evil2.txt', '/etc/evil3.txt']) {
    const { zipPath, dest } = writeZip([
      { name, data: 'evil' },
      { name: 'ok.txt', data: 'fine' },
    ]);
    await assert.rejects(
      extractZip(zipPath, dest),
      (error: unknown) => error instanceof ZipError
    );
    assert.equal(existsSync(join(dest, '..', 'evil.txt')), false);
  }
});

test('backslash entry names are normalized to forward slashes by yauzl', async () => {
  // yauzl (strictFileNames: false, the default) decodes '\' as '/', so a
  // Windows-built zip extracts into normal nested dirs; safeEntryPath's own
  // backslash check stays as defense in depth for other decode paths.
  const { zipPath, dest } = writeZip([
    { name: 'a\\b.txt', data: 'x' },
    { name: 'ok.txt', data: 'fine' },
  ]);
  const { files } = await extractZip(zipPath, dest);
  assert.equal(files, 2);
  assert.equal(readFileSync(join(dest, 'a', 'b.txt'), 'utf8'), 'x');
  assert.equal(readFileSync(join(dest, 'ok.txt'), 'utf8'), 'fine');
});

test('symlink entries are skipped', async () => {
  const { zipPath, dest } = writeZip([
    { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    { name: 'real.txt', data: 'x' },
  ]);
  const { files } = await extractZip(zipPath, dest);
  assert.equal(files, 1);
  assert.equal(existsSync(join(dest, 'link')), false);
});

test('.git entries are dropped (hook planting)', async () => {
  const { zipPath, dest } = writeZip([
    { name: '.git/hooks/post-checkout', data: '#!/bin/sh\nevil' },
    { name: 'sub/.git/config', data: 'x' },
    { name: 'index.html', data: 'ok' },
  ]);
  const { files } = await extractZip(zipPath, dest);
  assert.equal(files, 1);
  assert.equal(existsSync(join(dest, '.git')), false);
  assert.equal(existsSync(join(dest, 'sub', '.git')), false);
});

test('__MACOSX noise is dropped', async () => {
  const { zipPath, dest } = writeZip([
    { name: '__MACOSX/._index.html', data: 'junk' },
    { name: 'index.html', data: 'ok' },
  ]);
  const { files } = await extractZip(zipPath, dest);
  assert.equal(files, 1);
  assert.equal(existsSync(join(dest, '__MACOSX')), false);
});

test('entry-count cap aborts with a 413 ZipError', async () => {
  const { zipPath, dest } = writeZip([
    { name: 'a.txt', data: 'a' },
    { name: 'b.txt', data: 'b' },
    { name: 'c.txt', data: 'c' },
  ]);
  await assert.rejects(
    extractZip(zipPath, dest, { ...ZIP_LIMITS, maxEntries: 2 }),
    (error: unknown) => error instanceof ZipError && error.status === 413
  );
});

test('total uncompressed size cap aborts with a 413 ZipError', async () => {
  const { zipPath, dest } = writeZip([
    { name: 'big.txt', data: 'x'.repeat(2000) },
  ]);
  await assert.rejects(
    extractZip(zipPath, dest, { ...ZIP_LIMITS, maxTotalBytes: 100 }),
    (error: unknown) => error instanceof ZipError && error.status === 413
  );
});

test('a non-zip file rejects with a client-facing ZipError', async () => {
  const dir = scratch();
  const zipPath = join(dir, 'in.zip');
  writeFileSync(zipPath, 'this is not a zip');
  await assert.rejects(
    extractZip(zipPath, join(dir, 'out')),
    (error: unknown) => error instanceof ZipError
  );
});

test('stripWrapperDir hoists a single GitHub-style top folder', async () => {
  const dest = join(scratch(), 'out');
  mkdirSync(join(dest, 'my-site-main', 'css'), { recursive: true });
  writeFileSync(join(dest, 'my-site-main', 'index.html'), 'hi');
  writeFileSync(join(dest, 'my-site-main', 'css', 'a.css'), 'x');
  await stripWrapperDir(dest);
  assert.equal(readFileSync(join(dest, 'index.html'), 'utf8'), 'hi');
  assert.equal(existsSync(join(dest, 'my-site-main')), false);
});

test('stripWrapperDir leaves multi-entry roots alone', async () => {
  const dest = join(scratch(), 'out');
  mkdirSync(join(dest, 'folder'), { recursive: true });
  writeFileSync(join(dest, 'index.html'), 'hi');
  await stripWrapperDir(dest);
  assert.deepEqual((await readdir(dest)).sort(), ['folder', 'index.html']);
});

test('safeEntryPath rejects traversal, absolute, backslash and .git shapes', () => {
  const dest = '/safe/dest';
  assert.equal(safeEntryPath('../x', dest), null);
  assert.equal(safeEntryPath('a/../../x', dest), null);
  assert.equal(safeEntryPath('/abs', dest), null);
  assert.equal(safeEntryPath('C:/windows', dest), null);
  assert.equal(safeEntryPath('a\\b', dest), null);
  assert.equal(safeEntryPath('.git/config', dest), null);
  assert.equal(safeEntryPath('a/.git/config', dest), null);
  assert.equal(safeEntryPath('__MACOSX/._x', dest), null);
  assert.equal(safeEntryPath('ok/file.txt', dest), 'ok/file.txt');
});
