import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  PREVIEW_SESSION_LIVE_STATUSES,
  previewMessage,
  previewSession,
  type PreviewSessionStatus,
} from '@/db/schema';
import { previewConfig } from './config';
import { pumpMessages } from './chat';
import { lastActivity } from './proxy';
import { liveIds, liveSession, startSession, teardownSession } from './sessions';

const LIVE: PreviewSessionStatus[] = [...PREVIEW_SESSION_LIVE_STATUSES];

// Guards against double-starting a session while its pipeline (clone/install/
// spawn) is still running and it isn't in the live map yet.
const starting = new Set<string>();

const launch = (row: typeof previewSession.$inferSelect) => {
  if (starting.has(row.id) || liveSession(row.id)) return;
  starting.add(row.id);
  void startSession(row).finally(() => starting.delete(row.id));
};

/**
 * On boot the container/laptop restart killed every dev server, but clones,
 * node_modules and ~/.claude survive on disk — so live-status rows are
 * respawned in place and `--resume` keeps the chat context. Messages that were
 * mid-flight are failed with a resend prompt.
 */
export const bootReconcile = async () => {
  await db
    .update(previewMessage)
    .set({
      status: 'failed',
      error: 'The editing service restarted while working on this. Please resend your request.',
      finishedAt: new Date(),
    })
    .where(inArray(previewMessage.status, ['queued', 'running']));

  const rows = await db
    .select()
    .from(previewSession)
    .where(inArray(previewSession.status, LIVE));
  for (const row of rows) {
    // Old pid/port are stale by definition — startSession reallocates both.
    launch({ ...row, status: 'starting' });
  }
};

/**
 * One reconcile pass: adopt new sessions, honor close requests, run chat.
 * The API only writes rows (+ NOTIFY); every process action happens here.
 */
export const reconcileTick = async () => {
  const rows = await db
    .select()
    .from(previewSession)
    .where(inArray(previewSession.status, [...LIVE, 'closed', 'published']));

  const byId = new Map(rows.map((row) => [row.id, row]));

  // New sessions created by the API (status 'starting', no process yet).
  for (const row of rows) {
    if (row.status === 'starting') launch(row);
  }

  // Sessions the API marked terminal while their process still runs.
  for (const id of liveIds()) {
    const row = byId.get(id);
    if (!row || (row.status !== 'starting' && !LIVE.includes(row.status))) {
      await teardownSession(
        id,
        row?.status === 'published' ? 'published' : 'closed'
      );
    }
  }

  await pumpMessages();
};

/** Expires sessions idle past the TTL. Preview hits + chat both count. */
export const sweepIdle = async () => {
  const cutoff = new Date(Date.now() - previewConfig.idleMinutes * 60_000);
  const rows = await db
    .select()
    .from(previewSession)
    .where(
      and(
        inArray(previewSession.status, LIVE),
        lt(previewSession.lastActivityAt, cutoff)
      )
    );
  for (const row of rows) {
    // In-memory activity may be fresher than the last DB flush.
    const memory = lastActivity.get(row.id);
    if (memory && memory > cutoff.getTime()) continue;
    await teardownSession(row.id, 'expired');
  }
};

/** Prunes event rows of long-dead sessions the teardown path missed. */
export const pruneOrphanEvents = async () => {
  await db.execute(sql`
    DELETE FROM preview_event
    WHERE session_id IN (
      SELECT id FROM preview_session
      WHERE status IN ('closed','published','expired','failed')
        AND closed_at < now() - interval '1 day'
    )
  `);
};
