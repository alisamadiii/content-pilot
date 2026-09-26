import 'dotenv/config';

/**
 * Preview-supervisor configuration. Everything URL-shaped is env-driven so the
 * whole feature runs locally without DNS/TLS:
 *  - local:  PREVIEW_URL_BASE=http://{id}.localhost:3020
 *  - prod:   PREVIEW_URL_BASE=https://{id}.preview.alisamadii.com
 * The `{id}` placeholder is replaced with the session id; the proxy routes by
 * the leftmost Host label in both cases.
 */
export const previewConfig = {
  urlBase: process.env.PREVIEW_URL_BASE || 'http://{id}.localhost:3020',
  proxyPort: Number(process.env.PREVIEW_PROXY_PORT) || 3020,
  portMin: Number(process.env.PREVIEW_PORT_MIN) || 4100,
  portMax: Number(process.env.PREVIEW_PORT_MAX) || 4109,
  maxSessions: Number(process.env.MAX_PREVIEW_SESSIONS) || 3,
  idleMinutes: Number(process.env.SESSION_IDLE_MINUTES) || 30,
  // Warn the client this many minutes before the idle kill (i.e. once the
  // session has been idle for idleMinutes - idleWarnMinutes). Default 20 →
  // warning fires at 10 min idle for a 30 min TTL.
  idleWarnMinutes: Number(process.env.SESSION_IDLE_WARN_MINUTES) || 20,
  installTimeoutMs: Number(process.env.INSTALL_TIMEOUT_MS) || 300_000,
  devReadyTimeoutMs: Number(process.env.DEV_READY_TIMEOUT_MS) || 120_000,
  messageTimeoutMs: Number(process.env.SESSION_MESSAGE_TIMEOUT_MS) || 600_000,
  // Match the batch jobs model (haiku) — cheap + fast for content edits. Bump
  // via SESSION_CLAUDE_MODEL if a client's edits need a stronger model.
  claudeModel: process.env.SESSION_CLAUDE_MODEL || 'haiku',
};

export const previewUrlFor = (sessionId: string) =>
  previewConfig.urlBase.replace('{id}', sessionId);
