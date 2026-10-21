import { previewConfig } from '@/preview/config';

// Pure rules behind src/lib/settings.ts, kept DB-free so they can be unit-tested
// without a DATABASE_URL (importing @/db throws when it is unset).

/** Per-repo AI provider override key (e.g. `ai_provider:1247662764`). */
export const providerKey = (repoId: number) => `ai_provider:${repoId}`;

/** Per-repo Gemini key tier key (e.g. `gemini_tier:1247662764`). */
export const geminiTierKey = (repoId: number) => `gemini_tier:${repoId}`;

export const MAX_SESSIONS_KEY = 'max_preview_sessions';
export const MAX_SESSIONS_CEILING = 20;

export type AiProvider = 'claude' | 'gemini';

/** Which Gemini key a project's sessions use. Free is the default. */
export type GeminiTier = 'free' | 'paid';

/**
 * Only the exact string `claude` (any case, trimmed) selects Claude; anything
 * else (unset, typo, legacy) falls back to gemini — the cheap default.
 */
export const normalizeProvider = (raw: string | null | undefined): AiProvider =>
  raw?.trim().toLowerCase() === 'claude' ? 'claude' : 'gemini';

/**
 * Only the exact string `paid` (any case, trimmed) selects the paid Gemini
 * key; anything else (unset, typo, `free`) falls back to the free key — the
 * default for the many unpaid client sites.
 */
export const normalizeGeminiTier = (raw: string | null | undefined): GeminiTier =>
  raw?.trim().toLowerCase() === 'paid' ? 'paid' : 'free';

/**
 * Picks the Gemini API key for a tier. Paid is honored only when a paid key is
 * actually configured; a paid request with no paid key degrades to the free
 * key (never a hard failure), and the returned `tier` reflects what was used.
 */
export const resolveGeminiKey = (params: {
  tier: GeminiTier;
  freeKey: string;
  paidKey: string;
}): { key: string; tier: GeminiTier } => {
  if (params.tier === 'paid' && params.paidKey) {
    return { key: params.paidKey, tier: 'paid' };
  }
  return { key: params.freeKey, tier: 'free' };
};

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
