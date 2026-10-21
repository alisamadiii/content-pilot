import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  dirSizeBytes,
  formatBytes,
  parsePsOutput,
  processSnapshot,
  treeRss,
} from './resource-usage';

// Disk + memory numbers behind the dashboard `urls` page.

const PS = `
    1     0   1000
  200     1   5000
  201   200   3000
  202   201   2000
  300     1   9000
garbage line
`;

test('parsePsOutput reads pid, ppid and rss (KiB → bytes), skipping junk', () => {
  const rows = parsePsOutput(PS);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], { pid: 200, ppid: 1, rssBytes: 5000 * 1024 });
});

test('treeRss sums a process and all its descendants', () => {
  const rows = parsePsOutput(PS);
  assert.equal(treeRss(rows, 200), (5000 + 3000 + 2000) * 1024);
  assert.equal(treeRss(rows, 202), 2000 * 1024);
  assert.equal(treeRss(rows, 300), 9000 * 1024);
});

test('treeRss is null for a pid that is not running', () => {
  assert.equal(treeRss(parsePsOutput(PS), 999), null);
});

test('treeRss survives a ppid cycle', () => {
  const rows = [
    { pid: 10, ppid: 11, rssBytes: 1 },
    { pid: 11, ppid: 10, rssBytes: 2 },
  ];
  assert.equal(treeRss(rows, 10), 3);
});

test('processSnapshot sees the current process', async () => {
  const rows = await processSnapshot();
  const self = treeRss(rows, process.pid);
  assert.ok(self !== null && self > 0);
});

test('dirSizeBytes measures a directory; missing path is 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-du-'));
  writeFileSync(join(dir, 'a.bin'), Buffer.alloc(64 * 1024));
  assert.ok((await dirSizeBytes(dir)) >= 64 * 1024);
  assert.equal(await dirSizeBytes(join(dir, 'nope')), 0);
});

test('formatBytes picks a readable unit', () => {
  assert.equal(formatBytes(null), '-');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(8.5 * 1024 * 1024), '8.5 MB');
  assert.equal(formatBytes(201 * 1024 * 1024), '201 MB');
  assert.equal(formatBytes(1.2 * 1024 ** 3), '1.2 GB');
});
