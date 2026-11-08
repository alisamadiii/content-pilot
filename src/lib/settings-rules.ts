import { previewConfig } from '@/preview/config';

// Pure rules behind src/lib/settings.ts, kept DB-free so they can be unit-tested
// without a DATABASE_URL (importing @/db throws when it is unset).

/** Per-project AI provider override key (`ai_provider:<projectId>`). */
export const providerKey = (projectId: string) => `ai_provider:${projectId}`;

export const MAX_SESSIONS_KEY = 'max_preview_sessions';
export const MAX_SESSIONS_CEILING = 20;

export type AiProvider = 'claude' | 'gemini';

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
