'use server';

import { and, eq, inArray } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { client, db } from '@/db';
import { job } from '@/db/schema';
import { auth } from '@/lib/auth';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

// Wake the worker immediately instead of waiting for the next poll.
const wakeWorker = async () => {
  try {
    await client.notify('cp_run_now', '');
  } catch {
    // NOTIFY is best-effort; the worker still picks the job up on its next poll.
  }
};

/** Re-queue a finished job (failed/rejected/canceled) with its original prompt. */
export const retryJob = async (id: number) => {
  await requireSession();
  const updated = await db
    .update(job)
    .set({
      status: 'queued',
      error: null,
      resultSummary: null,
      commitSha: null,
      logs: null,
      batchId: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(job.id, id), inArray(job.status, ['failed', 'rejected', 'canceled']))
    )
    .returning({ id: job.id });
  if (updated.length) {
    await wakeWorker();
  }
  revalidatePath('/jobs');
};

/** Run a queued job now — wakes the worker so it doesn't wait for the poll. */
export const runJobNow = async (id: number) => {
  await requireSession();
  const [row] = await db
    .select({ status: job.status })
    .from(job)
    .where(eq(job.id, id))
    .limit(1);
  if (row?.status === 'queued') {
    await wakeWorker();
  }
  revalidatePath('/jobs');
};
