'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { client } from '@/db';
import { auth } from '@/lib/auth';
import { getDomainRepoId, removeDomainMapping } from '@/lib/settings';
import { removeLiveBuilds } from '@/preview/live-build';
import { removeLiveSnapshot } from '@/preview/live-serve';
import { killSession } from '../sessions/actions';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

/**
 * Takes a project's live site offline: deletes the built files and the build
 * history. Its domains stay mapped and show the "not published yet" page; the
 * next publish builds and serves it again.
 */
export const takeLiveSiteDown = async (repoId: number) => {
  await requireSession();
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    throw new Error('Invalid repoId');
  }
  await removeLiveSnapshot(repoId);
  await removeLiveBuilds(repoId);
  revalidatePath('/urls');
};

/**
 * Stops serving one host (free subdomain or custom domain) from the pilot. The
 * hub's Domain tab and any Cloudflare hostname are not touched.
 */
export const removeDomain = async (host: string) => {
  await requireSession();
  if ((await getDomainRepoId(host)) === null) return;
  await removeDomainMapping(host);
  try {
    await client.notify('cp_domains', '');
  } catch {
    // The supervisor also refreshes the domain map on an interval.
  }
  revalidatePath('/urls');
};

/** Ends an editing preview session (same kill switch as the sessions page). */
export const endPreview = async (sessionId: string) => {
  await killSession(sessionId);
  revalidatePath('/urls');
};
