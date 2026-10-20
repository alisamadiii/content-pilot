import { and, eq, inArray } from 'drizzle-orm';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { client, db } from '@/db';
import {
  previewSession,
  PREVIEW_SESSION_LIVE_STATUSES,
} from '@/db/schema';
import { verifyApiKey } from '@/lib/api-key';
import { extractCredentials } from '@/lib/request-credentials';
import { listDomainsForRepo, removeAllDomainsForRepo } from '@/lib/settings';
import { config } from '@/worker/config';
import { repoDir } from '@/worker/git';
import {
  isLiveServable,
  liveUrlFor,
  removeLiveSnapshot,
} from '@/preview/live-serve';
import { detectFramework } from '@/preview/framework';
import { findAppDir } from '@/preview/session-boot';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only) management of uploaded workspaces:
 *  - GET: does the workspace exist (hub's finalizeUpload verification)?
 *  - DELETE: remove workspace + live snapshot when the hub deletes the
 *    project — an upload project's live site must go down with its row.
 */

const authenticate = async (request: Request) => {
  const { apiKeyCandidate } = extractCredentials(request);
  return Boolean(await verifyApiKey(apiKeyCandidate));
};

const parseRepoId = (raw: string) => {
  const repoId = Number(raw);
  return Number.isSafeInteger(repoId) && repoId > 0 ? repoId : null;
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  const dir = repoDir(repoId);
  const exists = existsSync(join(dir, '.git'));
  let framework: string | null = null;
  if (exists) {
    try {
      framework = detectFramework(findAppDir(dir));
    } catch {
      framework = null;
    }
  }
  const liveUrl = exists && isLiveServable(repoId) ? liveUrlFor(repoId) : null;
  const domains = exists ? await listDomainsForRepo(repoId) : [];
  return Response.json({ exists, framework, liveUrl, domains });
};

export const DELETE = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
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
    return Response.json(
      { error: 'A live preview session is using this project.' },
      { status: 409 }
    );
  }

  // Path safety: same direct-child check as the admin workspaces delete.
  const base = resolve(config.workspaceDir);
  const target = resolve(join(base, String(repoId)));
  if (target === base || !target.startsWith(base + sep)) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
  }
  await removeLiveSnapshot(repoId);
  // The live site's domains die with the project.
  await removeAllDomainsForRepo(repoId);
  try {
    await client.notify('cp_domains', '');
  } catch {
    // The supervisor also refreshes on an interval.
  }
  return Response.json({ deleted: true });
};
