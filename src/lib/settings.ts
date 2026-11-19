import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { decryptSecret, encryptSecret, hasSecretKey } from './secret-box';
import {
  clampMaxSessions,
  MAX_SESSIONS_KEY,
  normalizeProvider,
  projectEnvKey,
  providerKey,
  type AiProvider,
} from './settings-rules';

export {
  MAX_SESSIONS_KEY,
  projectEnvKey,
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
 * A project's preview env values, decrypted. No row, no ENV_ENCRYPTION_KEY, or
 * a blob that won't decrypt (key rotated, tampered) all read as {} — the
 * preview boots without them rather than failing. Values are never logged.
 */
export const getProjectEnv = async (
  projectId: string
): Promise<Record<string, string>> => {
  const blob = await getSetting(projectEnvKey(projectId));
  if (!blob) return {};
  if (!hasSecretKey()) {
    console.warn(
      `[settings] project ${projectId}: env values stored but ENV_ENCRYPTION_KEY is unset — ignoring them`
    );
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(decryptSecret(blob));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    console.warn(
      `[settings] project ${projectId}: env values could not be decrypted — ignoring them`
    );
    return {};
  }
};

/**
 * Applies `values` on top of the stored ones (an empty string removes that
 * key) and saves the result encrypted; an empty result deletes the row.
 * Throws when ENV_ENCRYPTION_KEY is missing or invalid (nothing is written).
 */
export const setProjectEnv = async (
  projectId: string,
  values: Record<string, string>
): Promise<void> => {
  // Fail on a missing/bad key before reading, so nothing is half-applied.
  encryptSecret('');
  const next = await getProjectEnv(projectId);
  for (const [key, value] of Object.entries(values)) {
    if (value === '') delete next[key];
    else next[key] = value;
  }
  if (Object.keys(next).length === 0) {
    await db.delete(appSetting).where(eq(appSetting.key, projectEnvKey(projectId)));
    return;
  }
  await setSetting(projectEnvKey(projectId), encryptSecret(JSON.stringify(next)));
};

/**
 * Removes a project's settings overrides (project delete). The legacy
 * `gemini_tier:` row (free/paid key tier, removed 2026-11-07) is swept too so
 * old projects leave nothing behind. Includes the project's env values.
 */
export const removeProjectSettings = async (projectId: string): Promise<void> => {
  await db
    .delete(appSetting)
    .where(
      inArray(appSetting.key, [
        providerKey(projectId),
        projectEnvKey(projectId),
        `gemini_tier:${projectId}`,
      ])
    );
};

