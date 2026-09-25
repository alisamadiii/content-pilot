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

/** Per-repo app-subfolder override key (e.g. `app_dir:1247662764`). */
export const appDirKey = (repoId: number) => `app_dir:${repoId}`;

/**
 * The configured app subfolder for a repo (relative to the clone root), or null
 * when unset/auto. Sanitized: trimmed, slashes stripped, and traversal/absolute
 * paths rejected so the value can only ever name a folder inside the clone.
 */
export const getAppDir = async (repoId: number): Promise<string | null> => {
  const raw = await getSetting(appDirKey(repoId));
  const value = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!value) return null;
  if (value.startsWith('/') || value.split('/').includes('..')) return null;
  return value;
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
