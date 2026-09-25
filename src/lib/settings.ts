import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { previewConfig } from '@/preview/config';

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

export const MAX_SESSIONS_KEY = 'max_preview_sessions';
const MAX_SESSIONS_CEILING = 20;

/**
 * Effective cap on concurrent live preview sessions: the DB override when set
 * and valid, else the env/code default (previewConfig.maxSessions). Clamped to
 * a sane range so a bad row can't disable or overload the pool.
 */
export const getMaxSessions = async (): Promise<number> => {
  const raw = await getSetting(MAX_SESSIONS_KEY);
  const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
  const value = Number.isInteger(parsed) && parsed > 0
    ? parsed
    : previewConfig.maxSessions;
  return Math.min(Math.max(1, value), MAX_SESSIONS_CEILING);
};
