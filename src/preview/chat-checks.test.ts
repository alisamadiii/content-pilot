import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, type Server } from 'http';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  commitTitle,
  countToolUses,
  MAX_REPAIR_RUNS,
  PAGE_PROBE_TIMEOUT_MS,
  REJECTED_MESSAGE,
  stripHtml,
  touchesSharedCms,
  verifyChanges,
} from './chat-checks';

// ------------------------------------------------------------- pure helpers

test('countToolUses counts tool_use blocks in assistant events only', () => {
  const assistant = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use' }, { type: 'tool_use' }] },
  };
  assert.equal(countToolUses(assistant), 2);
  assert.equal(countToolUses({ ...assistant, type: 'stream_event' }), 0);
  assert.equal(countToolUses({ type: 'assistant', message: { content: 'text' } }), 0);
  assert.equal(countToolUses({ type: 'assistant' }), 0);
  assert.equal(countToolUses(null), 0);
  assert.equal(countToolUses(undefined), 0);
});

test('stripHtml drops script/style blocks and tags, collapses whitespace', () => {
  assert.equal(
    stripHtml('<html><head><style>h1{color:red}</style></head><body>\n  <h1>Oops</h1>\n<script>var x = "<b>";</script><pre>Cannot   find\nmodule</pre></body></html>'),
    'Oops Cannot find module'
  );
  assert.equal(stripHtml('plain  text'), 'plain text');
  assert.equal(stripHtml(''), '');
});

test('touchesSharedCms: _site.json, _pages.json and _collections/* at any depth; look-alikes do not count', () => {
  assert.equal(touchesSharedCms(['_site.json']), true);
  assert.equal(touchesSharedCms(['src/x.astro', '_pages.json']), true);
  assert.equal(touchesSharedCms(['_collections/team.json']), true);
  assert.equal(touchesSharedCms(['site/_site.json']), true);
  assert.equal(touchesSharedCms(['src/_site.json.bak']), false);
  assert.equal(touchesSharedCms(['data/site.json', 'my_collections/x.json']), false);
  assert.equal(touchesSharedCms([]), false);
});

test('commitTitle is the first line, capped at 72 chars', () => {
  assert.equal(commitTitle('Change the headline\nand more'), 'Change the headline');
  assert.equal(commitTitle('x'.repeat(100)).length, 72);
  assert.equal(commitTitle(''), '');
});

test('constants the pump relies on', () => {
  assert.equal(MAX_REPAIR_RUNS, 2);
  assert.equal(PAGE_PROBE_TIMEOUT_MS, 30_000);
  assert.match(REJECTED_MESSAGE, /files the editor must not modify/);
  assert.match(REJECTED_MESSAGE, /reach out to your developer/);
});

// ----------------------------------------------------------- verifyChanges

let server: Server;
let port: number;
let hits: string[] = [];
let dir: string;

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/ok' || req.url === '/about') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>fine</h1>');
    } else if (req.url === '/boom') {
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end('<html><head><style>x{}</style></head><body><h1>Error</h1><script>1</script><pre>Cannot find module "x"</pre></body></html>');
    } else if (req.url === '/') {
      res.writeHead(500);
      res.end('home broken');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  dir = await mkdtemp(join(tmpdir(), 'cp-verify-'));
  await writeFile(join(dir, 'good.json'), '{"a":1}');
  await writeFile(join(dir, 'bad.json'), '{"a":1,}');
  await writeFile(join(dir, 'page.astro'), '---');
});
after(() => server.close());

test('invalid JSON in a changed file is reported before any page probe', async () => {
  hits = [];
  const neverFetch: typeof fetch = async () => {
    throw new Error('must not probe');
  };
  const out = await verifyChanges(dir, port, ['page.astro', 'bad.json'], '/ok', neverFetch);
  assert.match(out ?? '', /^bad\.json is no longer valid JSON: /);
  assert.deepEqual(hits, []);
});

test('non-JSON files and valid JSON pass the parse check', async () => {
  assert.equal(await verifyChanges(dir, port, ['page.astro', 'good.json'], '/ok'), null);
});

test('a 5xx on the viewed page returns the status and the stripped error body', async () => {
  const out = await verifyChanges(dir, port, ['page.astro'], '/boom');
  assert.equal(out, 'GET /boom now returns 500. Dev server error: Error Cannot find module "x"');
});

test('a 404 is not a break (only >= 500 counts)', async () => {
  assert.equal(await verifyChanges(dir, port, ['page.astro'], '/missing'), null);
});

test('shared CMS change probes / after the viewed page; non-shared changes do not', async () => {
  await writeFile(join(dir, '_site.json'), '{}');
  hits = [];
  const out = await verifyChanges(dir, port, ['_site.json'], '/about');
  assert.equal(out, 'GET / now returns 500. Dev server error: home broken');
  assert.deepEqual(hits, ['/about', '/']);
  hits = [];
  assert.equal(await verifyChanges(dir, port, ['page.astro'], '/about'), null);
  assert.deepEqual(hits, ['/about']);
  // Viewing / already: probed exactly once, not twice.
  hits = [];
  await verifyChanges(dir, port, ['_site.json'], '/');
  assert.deepEqual(hits, ['/']);
});

test('a page-probe failure (refused, aborted) is infrastructure noise, not a problem', async () => {
  // Closed port → ECONNREFUSED.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  assert.equal(await verifyChanges(dir, deadPort, ['page.astro'], '/boom'), null);
  // Timeout path: the probe carries an AbortSignal and an abort is swallowed.
  let sawSignal = false;
  const aborting: typeof fetch = async (_url, init) => {
    sawSignal = init?.signal instanceof AbortSignal;
    throw new DOMException('The operation was aborted', 'TimeoutError');
  };
  assert.equal(await verifyChanges(dir, port, ['page.astro'], '/boom', aborting), null);
  assert.equal(sawSignal, true);
});

test('a 5xx whose body cannot be read still reports the status', async () => {
  const brokenBody: typeof fetch = async () =>
    ({ status: 503, text: () => Promise.reject(new Error('stream died')) }) as unknown as Response;
  assert.equal(
    await verifyChanges(dir, port, ['page.astro'], '/x', brokenBody),
    'GET /x now returns 503. Dev server error: '
  );
});
