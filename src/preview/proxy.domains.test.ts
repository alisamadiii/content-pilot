import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, get, type Server } from 'http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect } from 'net';

// Proxy custom-domain routing with an injected resolver: mapped hosts serve
// their published snapshot and can never reach session routes; unmapped hosts
// behave exactly as before. Env pinned before the dynamic import (live-serve
// reads WORKSPACE_DIR via worker/config at import time).
const ws = mkdtempSync(join(tmpdir(), 'cp-proxy-dom-'));
process.env.WORKSPACE_DIR = ws;
process.env.PREVIEW_URL_BASE = 'http://{id}.localhost:3020';

const MAPPED_REPO = 1000000000200;
const UNPUBLISHED_REPO = 1000000000201;
const DOMAIN = 'www.client.test';

type ProxyMod = typeof import('./proxy');
let proxyMod: ProxyMod;
let proxyServer: Server;
let proxyPort: number;
let sessionServer: Server;

const request = (
  host: string,
  path = '/'
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    get(
      { host: '127.0.0.1', port: proxyPort, path, headers: { host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    ).on('error', reject);
  });

before(async () => {
  proxyMod = await import('./proxy');

  // Published snapshot for the mapped repo.
  const current = join(ws, '.live', String(MAPPED_REPO), 'current');
  mkdirSync(current, { recursive: true });
  writeFileSync(join(current, 'index.html'), '<h1>live snapshot</h1>');
  // Astro build.format 'file' output: flat page files, not page/index.html.
  writeFileSync(join(current, 'gallery.html'), '<h1>gallery page</h1>');
  mkdirSync(join(current, 'about'), { recursive: true });
  writeFileSync(join(current, 'about', 'index.html'), '<h1>about page</h1>');

  // A fake dev server registered under the session label 'www' — the first
  // label of the mapped domain. The spoof guard must keep it unreachable.
  sessionServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('SESSION CONTENT');
  });
  await new Promise<void>((r) => sessionServer.listen(0, '127.0.0.1', r));
  const sessionPort = (sessionServer.address() as { port: number }).port;
  proxyMod.registerRoute('www', sessionPort);

  const domains = new Map([
    [DOMAIN, MAPPED_REPO],
    ['bare.client.test', UNPUBLISHED_REPO],
  ]);
  proxyServer = proxyMod.startProxy(0, {
    resolveDomain: (host) => domains.get(host) ?? null,
  });
  await new Promise<void>((r) => proxyServer.once('listening', () => r()));
  proxyPort = (proxyServer.address() as { port: number }).port;
});

after(() => {
  proxyMod.unregisterRoute('www');
  proxyServer?.close();
  sessionServer?.close();
});

test('a mapped host serves the published snapshot', async () => {
  const res = await request(DOMAIN);
  assert.equal(res.status, 200);
  assert.match(res.body, /live snapshot/);
});

test('mapped host with port and case still resolves', async () => {
  const res = await request(`WWW.Client.TEST:443`);
  assert.equal(res.status, 200);
  assert.match(res.body, /live snapshot/);
});

test('a mapped host never reaches a session with the same first label', async () => {
  // Sanity: the session IS reachable on its own label host.
  const viaLabel = await request('www.localhost');
  assert.match(viaLabel.body, /SESSION CONTENT/);
  // But the mapped domain (first label also 'www') gets the snapshot only.
  const viaDomain = await request(DOMAIN);
  assert.doesNotMatch(viaDomain.body, /SESSION CONTENT/);
});

test('a mapped host with no snapshot gets the not-published page', async () => {
  const res = await request('bare.client.test');
  assert.equal(res.status, 404);
  assert.match(res.body, /hasn't been published yet/);
});

test('unmapped unknown hosts still get the session-ended 404', async () => {
  const res = await request('nonsense.example');
  assert.equal(res.status, 404);
  assert.match(res.body, /preview session has ended/);
});

test('upgrade on a mapped host is destroyed', async () => {
  const closed = await new Promise<boolean>((resolve) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: ${DOMAIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      );
    });
    socket.on('close', () => resolve(true));
    socket.on('error', () => resolve(true));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);
  });
  assert.equal(closed, true);
});

test('clean URLs: /gallery serves gallery.html (Astro build.format file)', async () => {
  const res = await request(`site-${MAPPED_REPO}.localhost`, '/gallery');
  assert.equal(res.status, 200);
  assert.match(res.body, /gallery page/);
  const direct = await request(`site-${MAPPED_REPO}.localhost`, '/gallery.html');
  assert.match(direct.body, /gallery page/);
});

test('directory pages still resolve: /about serves about/index.html', async () => {
  const res = await request(`site-${MAPPED_REPO}.localhost`, '/about/');
  assert.equal(res.status, 200);
  assert.match(res.body, /about page/);
});

test('a real miss is a 404, served from the site 404.html once it ships one', async () => {
  const plain = await request(`site-${MAPPED_REPO}.localhost`, '/missing');
  assert.equal(plain.status, 404);
  writeFileSync(
    join(ws, '.live', String(MAPPED_REPO), 'current', '404.html'),
    '<h1>custom not found</h1>'
  );
  const custom = await request(`site-${MAPPED_REPO}.localhost`, '/missing');
  assert.equal(custom.status, 404);
  assert.match(custom.body, /custom not found/);
});
