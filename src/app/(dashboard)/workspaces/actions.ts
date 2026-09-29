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
import { appDirKey, providerKey, setSetting } from '@/lib/settings';
import { config } from '@/worker/config';

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
export const deleteRepoClone = async (repoId: number) => {
  await requireSession();
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error('Invalid repo id.');
  }

  const [liveSession] = await db
    .select({ id: previewSession.id })
    .from(previewSession)
    .where(
      and(
        eq(previewSession.repoId, repoId),
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
  const target = resolve(join(base, String(repoId)));
  if (target === base || !target.startsWith(base + sep)) {
    throw new Error('Refusing to delete outside the workspace.');
  }

  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }
  revalidatePath('/workspaces');
};

/**
 * Sets (or clears) the app subfolder a preview session should run in for a repo
 * whose site lives in a subdirectory (e.g. empowerher's `marketing/`). Empty
 * clears the override — the session then auto-detects the app dir.
 */
export const setAppDir = async (repoId: number, value: string) => {
  await requireSession();
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error('Invalid repo id.');
  }
  const cleaned = value.trim().replace(/^\/+|\/+$/g, '');
  if (cleaned.startsWith('/') || cleaned.split('/').includes('..')) {
    throw new Error('App folder must be a path inside the repo.');
  }
  await setSetting(appDirKey(repoId), cleaned);
  revalidatePath('/workspaces');
};

/**
 * Sets a repo's AI provider for future preview chat sessions. `gemini` (the
 * default, cheap) for unpaid projects; `claude` for paying clients. Only
 * affects sessions created after the change — provider is bound per session.
 */
export const setProvider = async (repoId: number, value: string) => {
  await requireSession();
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error('Invalid repo id.');
  }
  if (value !== 'claude' && value !== 'gemini') {
    throw new Error('Provider must be claude or gemini.');
  }
  await setSetting(providerKey(repoId), value);
  revalidatePath('/workspaces');
};
