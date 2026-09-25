'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { client, db } from '@/db';
import { previewSession, PREVIEW_SESSION_LIVE_STATUSES } from '@/db/schema';
import { auth } from '@/lib/auth';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

/**
 * Admin kill switch: end a live preview session to free its port and dev-server
 * slot. Only the DB row is written here — the preview supervisor notices the
 * terminal status on its next reconcile pass and does the actual teardown
 * (kills the dev server, unregisters the proxy route, prunes events).
 */
export const killSession = async (id: string) => {
  await requireSession();
  const updated = await db
    .update(previewSession)
    .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(previewSession.id, id),
        inArray(previewSession.status, [...PREVIEW_SESSION_LIVE_STATUSES])
      )
    )
    .returning({ id: previewSession.id });
  if (updated.length) {
    try {
      await client.notify('cp_preview', '');
    } catch {
      // NOTIFY is best-effort; the supervisor's slow pass tears it down anyway.
    }
  }
  revalidatePath('/sessions');
  revalidatePath(`/sessions/${id}`);
};
