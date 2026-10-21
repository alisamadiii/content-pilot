import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import finalhandler from 'finalhandler';
import httpProxy from 'http-proxy';
import serveStatic from 'serve-static';
import { previewConfig } from './config';
import { liveServeRoot, repoIdFromLiveLabel } from './live-serve';

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

/** Inlines the overlay before </head> (else </body>, else appended). Exported for tests. */
export const injectOverlay = (html: string, tag: string = OVERLAY_TAG): string => {
  if (!tag) return html;
  const head = html.search(/<\/head>/i);
  if (head !== -1) return html.slice(0, head) + tag + html.slice(head);
  const body = html.search(/<\/body>/i);
  if (body !== -1) return html.slice(0, body) + tag + html.slice(body);
  return html + tag;
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

/** Leftmost Host label, lowercased, port stripped. Exported for tests. */
export const sessionIdFromHost = (host: string | undefined) => {
  host = host || '';
  const label = host.split('.')[0]?.split(':')[0]?.toLowerCase() || '';
  return label;
};

/** Full Host header normalized for the domain map: lowercase, no port/dot. */
export const normalizedHost = (host: string | undefined) =>
  (host || '').split(':')[0]?.toLowerCase().replace(/\.$/, '') || '';

const endedPage = `<!doctype html><meta charset="utf-8"><title>Preview ended</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:1.25rem">This preview session has ended</h1>
<p style="color:#666">Close this tab and start a new editing session from your dashboard.</p></div></body>`;

const unpublishedPage = `<!doctype html><meta charset="utf-8"><title>Not published yet</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:1.25rem">This site hasn't been published yet</h1>
<p style="color:#666">Publish it from the editor and it will appear here.</p></div></body>`;

// Live-site serving for every project: `site-<repoId>` Host labels map to
// the published snapshot on disk (see live-serve.ts). One serve-static
// instance per repoId — the root path is constant and files are re-read from
// disk per request, so publish swaps need no invalidation.
const liveServers = new Map<number, ReturnType<typeof serveStatic>>();

const liveServerFor = (repoId: number) => {
  let server = liveServers.get(repoId);
  if (!server) {
    server = serveStatic(liveServeRoot(repoId), {
      dotfiles: 'deny',
      index: ['index.html'],
      // Clean URLs, like every static host: /gallery serves gallery.html
      // (Astro build.format 'file', plain multi-page HTML sites). Dev servers
      // already resolve these, so without it a page works in preview only.
      extensions: ['html'],
      // Previews and live sites sit behind Cloudflare; published state must
      // reflect a publish instantly, so nothing may edge-cache.
      setHeaders: (res) => res.setHeader('cache-control', 'no-store'),
    });
    liveServers.set(repoId, server);
  }
  return server;
};

/** Serves a live-site request for a known repoId (snapshot or 404 page). */
const serveLiveRepo = (
  req: IncomingMessage,
  res: ServerResponse,
  repoId: number
) => {
  if (!existsSync(liveServeRoot(repoId))) {
    res.writeHead(404, {
      'Content-Type': 'text/html',
      'cache-control': 'no-store',
    });
    res.end(unpublishedPage);
    return;
  }
  liveServerFor(repoId)(req, res, () => notFound(req, res, repoId));
};

/** A real miss: the site's own 404.html when it ships one, else plain 404. */
const notFound = (req: IncomingMessage, res: ServerResponse, repoId: number) => {
  const page = join(liveServeRoot(repoId), '404.html');
  if (req.method === 'GET' && existsSync(page)) {
    res.writeHead(404, { 'Content-Type': 'text/html', 'cache-control': 'no-store' });
    res.end(readFileSync(page));
    return;
  }
  finalhandler(req, res)(undefined);
};

/** Handles a `site-<id>` live-site request; true when the label matched one. */
const serveLive = (req: IncomingMessage, res: ServerResponse, label: string) => {
  const repoId = repoIdFromLiveLabel(label);
  if (repoId === null) return false;
  serveLiveRepo(req, res, repoId);
  return true;
};

export const startProxy = (
  port: number = previewConfig.proxyPort,
  options: {
    /**
     * Custom-domain map (host -> repoId) for uploaded projects. Checked on the
     * FULL normalized host before any session-label routing, so a mapped host
     * can only ever serve its own published snapshot — never a session.
     */
    resolveDomain?: (host: string) => number | null;
  } = {}
) => {
  const resolveDomain = options.resolveDomain ?? (() => null);
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
        // The body is buffered, so a chunked upstream (Next/Astro stream HTML)
        // must lose its transfer-encoding too: both headers together is an
        // invalid response that strict clients reject.
        delete headers['content-length'];
        delete headers['transfer-encoding'];
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
    // Custom domains first, on the full host — never falls through to session
    // routing (a visitor spoofing a mapped Host must not reach a session).
    const mapped = resolveDomain(normalizedHost(req.headers.host));
    if (mapped !== null) {
      serveLiveRepo(req, res, mapped);
      return;
    }
    const id = sessionIdFromHost(req.headers.host);
    if (serveLive(req, res, id)) return;
    const port = routes.get(id);
    if (!port) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end(endedPage);
      return;
    }
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });

  server.on('upgrade', (req, socket, head) => {
    if (resolveDomain(normalizedHost(req.headers.host)) !== null) {
      // Mapped domains serve static files — no WebSocket.
      socket.destroy();
      return;
    }
    const id = sessionIdFromHost(req.headers.host);
    if (repoIdFromLiveLabel(id) !== null) {
      // Live sites are static files — no WebSocket to speak of.
      socket.destroy();
      return;
    }
    const port = routes.get(id);
    if (!port) {
      socket.destroy();
      return;
    }
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  });

  server.listen(port, '0.0.0.0');
  return server;
};
