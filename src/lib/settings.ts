import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import {
  appDirKey,
  clampMaxSessions,
  MAX_SESSIONS_KEY,
  normalizeProvider,
  providerKey,
  sanitizeAppDir,
  type AiProvider,
} from './settings-rules';

export {
  appDirKey,
  MAX_SESSIONS_KEY,
  providerKey,
  type AiProvider,
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
 * The configured app subfolder for a repo (relative to the clone root), or null
 * when unset/auto. A stored value that fails sanitization (traversal, absolute)
 * is treated as unset rather than crashing the session.
 */
export const getAppDir = async (repoId: number): Promise<string | null> => {
  const raw = await getSetting(appDirKey(repoId));
  try {
    return sanitizeAppDir(raw);
  } catch {
    return null;
  }
};

/**
 * The AI provider a repo's chat sessions run on. Default is `gemini` (cheap) —
 * every project uses it unless Ali explicitly flips this to `claude` for a
 * paying client.
 */
export const getProvider = async (repoId: number): Promise<AiProvider> =>
  normalizeProvider(await getSetting(providerKey(repoId)));

/**
 * Effective cap on concurrent live preview sessions: the DB override when set
 * and valid, else the env/code default (previewConfig.maxSessions).
 */
export const getMaxSessions = async (): Promise<number> =>
  clampMaxSessions(await getSetting(MAX_SESSIONS_KEY));
