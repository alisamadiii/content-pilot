import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import {
  clampMaxSessions,
  MAX_SESSIONS_KEY,
  normalizeProvider,
  providerKey,
  type AiProvider,
} from './settings-rules';

export { MAX_SESSIONS_KEY, providerKey, type AiProvider } from './settings-rules';

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
 * The AI provider a project's chat sessions run on. Default is `gemini` (cheap) —
 * every project uses it unless Ali explicitly flips this to `claude` for a
 * paying client.
 */
export const getProvider = async (projectId: string): Promise<AiProvider> =>
  normalizeProvider(await getSetting(providerKey(projectId)));

/**
 * Effective cap on concurrent live preview sessions: the DB override when set
 * and valid, else the env/code default (previewConfig.maxSessions).
 */
export const getMaxSessions = async (): Promise<number> =>
  clampMaxSessions(await getSetting(MAX_SESSIONS_KEY));

/**
 * Removes a project's settings overrides (project delete). The legacy
 * `gemini_tier:` row (free/paid key tier, removed 2026-11-07) is swept too so
 * old projects leave nothing behind.
 */
export const removeProjectSettings = async (projectId: string): Promise<void> => {
  await db
    .delete(appSetting)
    .where(
      inArray(appSetting.key, [providerKey(projectId), `gemini_tier:${projectId}`])
    );
};

