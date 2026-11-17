import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildOnNetlify, deployFolder, NetlifyError, waitForNetlifyDeploy } from './netlify';
import { defaultNetlifyToml } from './build';

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

test('buildOnNetlify posts title + zip as multipart to the Build API', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ id: 'b1', deploy_id: 'dep9' });
  }) as typeof fetch;
  const id = await buildOnNetlify({ zip: Buffer.from('PK'), siteId: 's1', token: 't', title: 'Pub' });
  assert.equal(id, 'dep9');
  assert.equal(calls[0].url, 'https://api.netlify.com/api/v1/sites/s1/builds');
  const form = calls[0].init.body as FormData;
  assert.equal(form.get('title'), 'Pub');
  assert.ok(form.get('zip') instanceof Blob);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer t');
});

test('buildOnNetlify without a deploy id is a NetlifyError', async () => {
  globalThis.fetch = (async () => Response.json({ id: 'b1' })) as typeof fetch;
  await assert.rejects(
    buildOnNetlify({ zip: Buffer.from('PK'), siteId: 's1', token: 't', title: 'x' }),
    NetlifyError
  );
});

const stubStates = (states: { state: string; error_message?: string }[]) => {
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(states[Math.min(i++, states.length - 1)]);
  }) as typeof fetch;
};

test('waitForNetlifyDeploy polls until the deploy is ready', async () => {
  stubStates([{ state: 'enqueued' }, { state: 'building' }, { state: 'ready' }]);
  await waitForNetlifyDeploy('t', 'dep1', { intervalMs: 0 });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.netlify.com/api/v1/deploys/dep1');
});

test('waitForNetlifyDeploy surfaces the Netlify build error', async () => {
  stubStates([{ state: 'building' }, { state: 'error', error_message: 'Build script returned non-zero exit code: 2' }]);
  await assert.rejects(waitForNetlifyDeploy('t', 'dep1', { intervalMs: 0 }), /non-zero exit code: 2/);
});

test('waitForNetlifyDeploy treats a rejected deploy as failed', async () => {
  stubStates([{ state: 'rejected' }]);
  await assert.rejects(waitForNetlifyDeploy('t', 'dep1', { intervalMs: 0 }), NetlifyError);
});

test('waitForNetlifyDeploy gives up after the timeout', async () => {
  stubStates([{ state: 'building' }]);
  await assert.rejects(
    waitForNetlifyDeploy('t', 'dep1', { intervalMs: 0, timeoutMs: 0 }),
    /still building/
  );
});

test('defaultNetlifyToml publishes static sites as-is', () => {
  assert.equal(defaultNetlifyToml('static', dir), '[build]\n  publish = "."\n');
});

test('defaultNetlifyToml uses the build script when there is one', async () => {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc -b && vite build' } }));
  assert.match(defaultNetlifyToml('vite', dir), /command = "npm run build"\n  publish = "dist"/);
});

test('defaultNetlifyToml falls back to the framework CLI without a build script', async () => {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: {} }));
  assert.match(defaultNetlifyToml('astro', dir), /command = "npx astro build"/);
  assert.match(defaultNetlifyToml('vite', dir), /command = "npx vite build"/);
});
