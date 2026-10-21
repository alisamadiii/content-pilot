import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { domainKey } from './domain-rules';
import {
  clampMaxSessions,
  geminiTierKey,
  MAX_SESSIONS_KEY,
  normalizeGeminiTier,
  normalizeProvider,
  providerKey,
  type AiProvider,
  type GeminiTier,
} from './settings-rules';

export {
  geminiTierKey,
  MAX_SESSIONS_KEY,
  providerKey,
  type AiProvider,
  type GeminiTier,
} from './settings-rules';

/** Read a raw setting value, or null when unset. */
export const getSetting = async (key: string): Promise<string | null> => {
  const [row] = await db
    .select({ value: appSetting.value })
    .from(appSetting)
    .where(eq(appSetting.key, key))
    .limit(1);
  return row?.value ?? null;
};

/** Upsert a setting value. */
export const setSetting = async (key: string, value: string): Promise<void> => {
  await db
    .insert(appSetting)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: { value, updatedAt: new Date() },
    });
};

/**
 * The AI provider a repo's chat sessions run on. Default is `gemini` (cheap) —
 * every project uses it unless Ali explicitly flips this to `claude` for a
 * paying client.
 */
export const getProvider = async (repoId: number): Promise<AiProvider> =>
  normalizeProvider(await getSetting(providerKey(repoId)));

/**
 * The Gemini key tier a repo's sessions use: `free` (default) or `paid`. Read
 * live per message, so a change in the admin takes effect on the next message
 * (unlike provider, which is bound per session).
 */
export const getGeminiTier = async (repoId: number): Promise<GeminiTier> =>
  normalizeGeminiTier(await getSetting(geminiTierKey(repoId)));

/**
 * Effective cap on concurrent live preview sessions: the DB override when set
 * and valid, else the env/code default (previewConfig.maxSessions).
 */
export const getMaxSessions = async (): Promise<number> =>
  clampMaxSessions(await getSetting(MAX_SESSIONS_KEY));

// ---------------------------------------------------------------------------
// Domain serving map for uploaded projects: `domain:<host>` -> repoId. The
// forward key is the PK, so the proxy-facing lookup is one indexed read; the
// repo-scoped queries scan values, which is fine for a tiny settings table.
// ---------------------------------------------------------------------------

/** The repoId a mapped host serves, or null. */
export const getDomainRepoId = async (host: string): Promise<number | null> => {
  const value = await getSetting(domainKey(host));
  const repoId = Number(value);
  return value !== null && Number.isSafeInteger(repoId) && repoId > 0
    ? repoId
    : null;
};

export const setDomainMapping = async (
  host: string,
  repoId: number
): Promise<void> => setSetting(domainKey(host), String(repoId));

export const removeDomainMapping = async (host: string): Promise<void> => {
  await db.delete(appSetting).where(eq(appSetting.key, domainKey(host)));
};

/** Every mapped host for a repo (free subdomain + custom domain). */
export const listDomainsForRepo = async (repoId: number): Promise<string[]> => {
  const rows = await db
    .select({ key: appSetting.key })
    .from(appSetting)
    .where(
      and(like(appSetting.key, 'domain:%'), eq(appSetting.value, String(repoId)))
    );
  return rows.map((row) => row.key.slice('domain:'.length));
};

export const removeAllDomainsForRepo = async (
  repoId: number
): Promise<void> => {
  await db
    .delete(appSetting)
    .where(
      and(like(appSetting.key, 'domain:%'), eq(appSetting.value, String(repoId)))
    );
};

/** Removes a repo's per-project settings overrides (project delete). */
export const removeRepoSettings = async (repoId: number): Promise<void> => {
  await db
    .delete(appSetting)
    .where(
      inArray(appSetting.key, [
        providerKey(repoId),
        geminiTierKey(repoId),
      ])
    );
};

/** Every domain mapping, for the proxy's in-memory map. */
export const listAllDomainMappings = async (): Promise<Map<string, number>> => {
  const rows = await db
    .select({ key: appSetting.key, value: appSetting.value })
    .from(appSetting)
    .where(like(appSetting.key, 'domain:%'));
  const map = new Map<string, number>();
  for (const row of rows) {
    const repoId = Number(row.value);
    if (Number.isSafeInteger(repoId) && repoId > 0) {
      map.set(row.key.slice('domain:'.length), repoId);
    }
  }
  return map;
};
