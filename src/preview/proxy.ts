import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
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
 *
 * The proxy also injects the AI-analyzer overlay client script into every HTML
 * response. Doing it here (not in the client's build config) makes overlay
 * delivery identical for every framework — Astro, Vite, Next — so the injected
 * build config only has to stamp `data-cms-src`, never ship the overlay.
 */
const routes = new Map<string, number>();

// The overlay is framework-agnostic vanilla JS; read once at startup and inlined
// into every HTML page. cwd is the content-pilot repo root (see analyzer.ts).
const OVERLAY_TAG = (() => {
  try {
    const js = readFileSync(join(process.cwd(), 'ai-analyzer', 'overlay.js'), 'utf8');
    return `<script>window.__AI_ANALYZER__=1;\n${js}</script>`;
  } catch {
    return '';
  }
})();

const injectOverlay = (html: string): string => {
  if (!OVERLAY_TAG) return html;
  const head = html.search(/<\/head>/i);
  if (head !== -1) return html.slice(0, head) + OVERLAY_TAG + html.slice(head);
  const body = html.search(/<\/body>/i);
  if (body !== -1) return html.slice(0, body) + OVERLAY_TAG + html.slice(body);
  return html + OVERLAY_TAG;
};

// Note: proxy traffic deliberately does NOT count as session activity. Idle
// expiry is driven only by user messages (see messages route + chat.ts), so a
// tab left open on the preview no longer keeps the dev server alive forever.
export const registerRoute = (sessionId: string, port: number) => {
  routes.set(sessionId, port);
};

export const unregisterRoute = (sessionId: string) => {
  routes.delete(sessionId);
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
    // We rewrite HTML bodies to inject the overlay, so we own the response.
    selfHandleResponse: true,
  });

  // Force identity encoding upstream so HTML comes back uncompressed and can be
  // string-replaced. Dev servers (Vite/Next) serve HTML uncompressed anyway;
  // this is a guard against any that wouldn't.
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('accept-encoding', 'identity');
  });

  proxy.on(
    'proxyRes',
    (proxyRes: IncomingMessage, _req: IncomingMessage, res: ServerResponse) => {
      const headers = { ...proxyRes.headers };
      // Previews sit behind Cloudflare (orange cloud). Vite's dev server sends
      // no cache-control, so CF edge-caches css/js by extension (4h default) and
      // reloads serve pre-edit styles. no-store makes CF bypass every response.
      headers['cache-control'] = 'no-store';
      const status = proxyRes.statusCode || 200;
      const type = String(proxyRes.headers['content-type'] || '');
      const isHtml = type.includes('text/html');

      if (!isHtml) {
        // Everything else (JS/CSS/images/SSE/HMR) streams through untouched.
        res.writeHead(status, headers);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const html = injectOverlay(Buffer.concat(chunks).toString('utf8'));
        const body = Buffer.from(html, 'utf8');
        // Body length changed — drop upstream content-length and set our own.
        delete headers['content-length'];
        headers['content-length'] = String(body.length);
        res.writeHead(status, headers);
        res.end(body);
      });
      proxyRes.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end();
      });
    }
  );

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
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });

  server.on('upgrade', (req, socket, head) => {
    const id = sessionIdFromHost(req);
    const port = routes.get(id);
    if (!port) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  });

  server.listen(previewConfig.proxyPort, '0.0.0.0');
  return server;
};
