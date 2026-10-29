'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import {
  previewSession,
  PREVIEW_SESSION_LIVE_STATUSES,
} from '@/db/schema';
import { auth } from '@/lib/auth';
import {
  geminiTierKey,
  providerKey,
  setSetting,
} from '@/lib/settings';
import { normalizeGeminiTier, normalizeProvider } from '@/lib/settings-rules';
import { config } from '@/worker/config';
import { isProjectId } from '@/lib/project-id';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

/**
 * Permanently deletes a project's clone directory from the workspace. Guarded
 * against removing a tree that's in active use (a live preview session), and
 * path-checked so only a direct child of the workspace can ever be removed —
 * never a traversal target.
 */
export const deleteRepoClone = async (projectId: string) => {
  await requireSession();
  if (!isProjectId(projectId)) {
    throw new Error('Invalid project id.');
  }

  const [liveSession] = await db
    .select({ id: previewSession.id })
    .from(previewSession)
    .where(
      and(
        eq(previewSession.projectId, projectId),
        inArray(previewSession.status, [...PREVIEW_SESSION_LIVE_STATUSES])
      )
    )
    .limit(1);
  if (liveSession) {
    throw new Error(
      'A live preview session is using this project. End it first, then delete.'
    );
  }

  // Path safety: resolve and confirm the target is a direct child of the
  // workspace before any recursive delete.
  const base = resolve(config.workspaceDir);
  const target = resolve(join(base, projectId));
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error('Refusing to delete outside the workspace.');
  }

  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }
  revalidatePath('/workspaces');
};

/**
 * Sets a project's AI provider for future preview chat sessions. `gemini` (the
 * default, cheap) for unpaid projects; `claude` for paying clients. Only
 * affects sessions created after the change — provider is bound per session.
 */
export const setProvider = async (projectId: string, value: string) => {
  await requireSession();
  if (!isProjectId(projectId)) {
    throw new Error('Invalid project id.');
  }
  if (value !== 'claude' && value !== 'gemini') {
    throw new Error('Provider must be claude or gemini.');
  }
  await setSetting(providerKey(projectId), normalizeProvider(value));
  revalidatePath('/workspaces');
};

/**
 * Sets a project's Gemini key tier: `free` (default, unpaid sites) or `paid`.
 * Read live per message, so the change takes effect on the next message. Only
 * matters when the provider is gemini; harmless for claude projects.
 */
export const setGeminiTier = async (projectId: string, value: string) => {
  await requireSession();
  if (!isProjectId(projectId)) {
    throw new Error('Invalid project id.');
  }
  if (value !== 'free' && value !== 'paid') {
    throw new Error('Gemini tier must be free or paid.');
  }
  await setSetting(geminiTierKey(projectId), normalizeGeminiTier(value));
  revalidatePath('/workspaces');
};
