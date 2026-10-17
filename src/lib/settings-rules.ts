import { previewConfig } from '@/preview/config';

// Pure rules behind src/lib/settings.ts, kept DB-free so they can be unit-tested
// without a DATABASE_URL (importing @/db throws when it is unset).

/** Per-repo app-subfolder override key (e.g. `app_dir:1247662764`). */
export const appDirKey = (repoId: number) => `app_dir:${repoId}`;

/** Per-repo AI provider override key (e.g. `ai_provider:1247662764`). */
export const providerKey = (repoId: number) => `ai_provider:${repoId}`;

export const MAX_SESSIONS_KEY = 'max_preview_sessions';
export const MAX_SESSIONS_CEILING = 20;

export type AiProvider = 'claude' | 'gemini';

/**
 * Sanitized app subfolder: trimmed, surrounding slashes stripped, and
 * traversal/absolute paths rejected so the value can only ever name a folder
 * inside the clone. Returns null for unset/auto, throws for a bad path.
 */
export const sanitizeAppDir = (raw: string | null | undefined): string | null => {
  const value = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!value) return null;
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error('App folder must be a path inside the repo.');
  }
  return value;
};

/**
 * Only the exact string `claude` (any case, trimmed) selects Claude; anything
 * else (unset, typo, legacy) falls back to gemini — the cheap default.
 */
export const normalizeProvider = (raw: string | null | undefined): AiProvider =>
  raw?.trim().toLowerCase() === 'claude' ? 'claude' : 'gemini';

/**
 * Effective concurrent-session cap: the stored override when it is a positive
 * integer, else `fallback` (previewConfig.maxSessions). Clamped to
 * 1..MAX_SESSIONS_CEILING so a bad row can't disable or overload the pool.
 */
export const clampMaxSessions = (
  raw: string | null | undefined,
  fallback: number = previewConfig.maxSessions
): number => {
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  const value = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.max(1, value), MAX_SESSIONS_CEILING);
};
