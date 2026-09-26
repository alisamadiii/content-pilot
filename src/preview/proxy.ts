import { createServer, type IncomingMessage } from 'http';
import httpProxy from 'http-proxy';
import { previewConfig } from './config';

/**
 * One reverse proxy for every preview session. Routing key is the leftmost
 * label of the Host header (<sessionId>.preview.alisamadii.com in prod,
 * <sessionId>.localhost locally) — same code path in both environments.
 *
 * `changeOrigin: true` rewrites Host to the target (localhost:<port>) for both
 * plain requests and the HMR WebSocket upgrade, which keeps Vite's host check
 * happy without per-repo config.
 */
const routes = new Map<string, number>();

// Touched on every proxied hit; sessions.ts flushes this to the DB and the
// idle sweep reads it — a client just *looking* at the preview keeps it alive.
export const lastActivity = new Map<string, number>();

export const registerRoute = (sessionId: string, port: number) => {
  routes.set(sessionId, port);
  lastActivity.set(sessionId, Date.now());
};

export const unregisterRoute = (sessionId: string) => {
  routes.delete(sessionId);
  lastActivity.delete(sessionId);
};

const sessionIdFromHost = (req: IncomingMessage) => {
  const host = req.headers.host || '';
  const label = host.split('.')[0]?.split(':')[0]?.toLowerCase() || '';
  return label;
};

const endedPage = `<!doctype html><meta charset="utf-8"><title>Preview ended</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:1.25rem">This preview session has ended</h1>
<p style="color:#666">Close this tab and start a new editing session from your dashboard.</p></div></body>`;

export const startProxy = () => {
  const proxy = httpProxy.createProxyServer({
    ws: true,
    changeOrigin: true,
  });

  proxy.on('proxyRes', (proxyRes) => {
    // Previews sit behind Cloudflare (orange cloud). Vite's dev server sends
    // no cache-control, so CF edge-caches css/js by extension (4h default) and
    // reloads serve pre-edit styles. no-store makes CF bypass every response.
    proxyRes.headers['cache-control'] = 'no-store';
  });

  proxy.on('error', (_error, _req, res) => {
    // Dev server mid-restart or just died — plain 502, the canvas retries.
    if (res && 'writeHead' in res && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Preview temporarily unavailable');
    } else {
      res?.end?.();
    }
  });

  const server = createServer((req, res) => {
    const id = sessionIdFromHost(req);
    const port = routes.get(id);
    if (!port) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(endedPage);
      return;
    }
    lastActivity.set(id, Date.now());
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });

  server.on('upgrade', (req, socket, head) => {
    const id = sessionIdFromHost(req);
    const port = routes.get(id);
    if (!port) {
      socket.destroy();
      return;
    }
    lastActivity.set(id, Date.now());
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  });

  server.listen(previewConfig.proxyPort, '0.0.0.0');
  return server;
};
