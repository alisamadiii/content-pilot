import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request, type IncomingMessage, type Server } from 'http';
import { connect } from 'net';
import {
  injectOverlay,
  registerRoute,
  sessionIdFromHost,
  startProxy,
  unregisterRoute,
} from './proxy';

// ---------------------------------------------------------------- pure bits

test('injectOverlay places the tag before </head>, else </body>, else at the end', () => {
  const tag = '<script>T</script>';
  assert.equal(injectOverlay('<html><HEAD></HEAD><body>x</body></html>', tag), '<html><HEAD><script>T</script></HEAD><body>x</body></html>');
  assert.equal(injectOverlay('<body>x</body>', tag), '<body>x<script>T</script></body>');
  assert.equal(injectOverlay('<p>fragment</p>', tag), '<p>fragment</p><script>T</script>');
  assert.equal(injectOverlay('<p>x</p>', ''), '<p>x</p>');
});

test('the default overlay tag is the real overlay.js, marked with the analyzer flag', () => {
  const out = injectOverlay('<head></head>');
  assert.match(out, /^<head><script>window\.__AI_ANALYZER__=1;\n/);
  assert.match(out, /element-pick/); // the overlay's postMessage type
  assert.match(out, /<\/script><\/head>$/);
});

test('sessionIdFromHost takes the lowercase leftmost label, port stripped', () => {
  assert.equal(sessionIdFromHost('ABC123.preview.example.com'), 'abc123');
  assert.equal(sessionIdFromHost('abc123.localhost:3020'), 'abc123');
  assert.equal(sessionIdFromHost('abc123:3020'), 'abc123');
  assert.equal(sessionIdFromHost('localhost'), 'localhost');
  assert.equal(sessionIdFromHost(undefined), '');
  assert.equal(sessionIdFromHost(''), '');
});

// ------------------------------------------------------- end-to-end proxy

let upstream: Server;
let upstreamPort: number;
let proxy: Server;
let proxyPort: number;
let seen: IncomingMessage[] = [];

const freePort = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};

const get = (host: string, path: string) =>
  new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.end();
  });

before(async () => {
  upstream = createServer((req, res) => {
    seen.push(req);
    if (req.url === '/') {
      const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(html)) });
      res.end(html);
    } else if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=3600' });
      res.end('body{}</head>');
    } else if (req.url === '/api') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<body>missing</body>');
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as { port: number }).port;
  proxyPort = await freePort();
  proxy = startProxy(proxyPort);
  await new Promise<void>((r) => proxy.once('listening', () => r()));
  registerRoute('live', upstreamPort);
  registerRoute('dead', await freePort());
});
after(() => {
  proxy.close();
  upstream.close();
});

test('HTML responses get the overlay injected, no-store caching and a corrected content-length', async () => {
  seen = [];
  const res = await get('live.localhost:3020', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /<script>window\.__AI_ANALYZER__=1;[\s\S]*<\/script><\/head>/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)));
  assert.ok(Buffer.byteLength(res.body) > 80, 'body grew past the original html');
  // Upstream saw a rewritten Host (changeOrigin) and an identity accept-encoding.
  assert.equal(seen[0].headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(seen[0].headers['accept-encoding'], 'identity');
});

test('the routing key is the leftmost label regardless of case or domain suffix', async () => {
  assert.equal((await get('LIVE.preview.example.com', '/')).status, 200);
  assert.equal((await get('live', '/')).status, 200);
});

test('non-HTML responses stream through untouched (status, body) but still get no-store', async () => {
  const css = await get('live.localhost', '/style.css');
  assert.equal(css.status, 200);
  assert.equal(css.body, 'body{}</head>');
  assert.equal(css.headers['cache-control'], 'no-store');
  const api = await get('live.localhost', '/api');
  assert.equal(api.status, 201);
  assert.equal(api.body, '{"ok":true}');
});

test('an upstream 404 HTML page keeps its status and still gets the overlay', async () => {
  const res = await get('live.localhost', '/nope');
  assert.equal(res.status, 404);
  assert.match(res.body, /<script>window\.__AI_ANALYZER__=1;[\s\S]*<\/script><\/body>/);
});

test('an unknown session renders the ended page with a 404', async () => {
  const res = await get('ghost.localhost', '/');
  assert.equal(res.status, 404);
  assert.match(res.body, /This preview session has ended/);
  assert.doesNotMatch(res.body, /__AI_ANALYZER__/);
});

test('unregisterRoute makes a session unreachable', async () => {
  registerRoute('temp', upstreamPort);
  assert.equal((await get('temp.localhost', '/')).status, 200);
  unregisterRoute('temp');
  assert.equal((await get('temp.localhost', '/')).status, 404);
});

test('a registered session whose dev server is down answers 502', async () => {
  const res = await get('dead.localhost', '/');
  assert.equal(res.status, 502);
  assert.equal(res.body, 'Preview temporarily unavailable');
});

test('a websocket upgrade for an unknown session is dropped without a response', async () => {
  const outcome = await new Promise<string>((resolve) => {
    const sock = connect(proxyPort, '127.0.0.1', () => {
      sock.write('GET / HTTP/1.1\r\nHost: ghost.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    let data = '';
    sock.on('data', (c) => (data += c.toString()));
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(data));
  });
  assert.equal(outcome, '');
});
