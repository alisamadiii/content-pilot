import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { deployFolder, NetlifyError } from './netlify';

let dir: string;
const calls: { url: string; init: RequestInit }[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'netlify-test-'));
  await writeFile(join(dir, 'index.html'), '<h1>hi</h1>');
  await mkdir(join(dir, 'css'));
  await writeFile(join(dir, 'css', 'site.css'), 'body{}');
  // Same bytes as index.html: one upload covers both paths.
  await writeFile(join(dir, 'copy.html'), '<h1>hi</h1>');
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, '.git', 'HEAD'), 'ref');
  calls.length = 0;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

const stubFetch = (required: (digest: Record<string, string>) => string[]) => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === 'POST') {
      const { files } = JSON.parse(init.body as string);
      return Response.json({ id: 'dep1', required: required(files) });
    }
    return Response.json({});
  }) as typeof fetch;
};

test('deployFolder posts a sha1 digest of every file except git metadata', async () => {
  stubFetch(() => []);
  await deployFolder({ dir, siteId: 's1', token: 't', title: 'x' });
  const { files } = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(Object.keys(files).sort(), ['/copy.html', '/css/site.css', '/index.html']);
  assert.equal(files['/index.html'], files['/copy.html']);
  assert.equal(calls[0].url, 'https://api.netlify.com/api/v1/sites/s1/deploys');
});

test('deployFolder uploads only the required hashes, once per hash', async () => {
  stubFetch((files) => [files['/index.html'], files['/css/site.css']]);
  const id = await deployFolder({ dir, siteId: 's1', token: 't', title: 'x' });
  assert.equal(id, 'dep1');
  const puts = calls.filter((c) => c.init.method === 'PUT').map((c) => c.url);
  assert.equal(puts.length, 2);
  assert.ok(puts.includes('https://api.netlify.com/api/v1/deploys/dep1/files/css/site.css'));
});

test('deployFolder turns a 401 into a NetlifyError', async () => {
  globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(
    deployFolder({ dir, siteId: 's1', token: 't', title: 'x' }),
    NetlifyError
  );
});
