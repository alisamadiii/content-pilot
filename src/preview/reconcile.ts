import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  PREVIEW_SESSION_LIVE_STATUSES,
  previewMessage,
  previewSession,
  type PreviewSessionStatus,
} from '@/db/schema';
import { previewConfig } from './config';
import { cancelSession, pumpMessages, sessionBusy } from './chat';
import { emitEvent } from './events';
import {
  liveIds,
  liveSession,
  pauseSession,
  resetSession,
  startSession,
  teardownSession,
} from './sessions';

const LIVE: PreviewSessionStatus[] = [...PREVIEW_SESSION_LIVE_STATUSES];

// Guards against double-starting a session while its pipeline (clone/install/
// spawn) is still running and it isn't in the live map yet.
const starting = new Set<string>();

// Guards against re-running a discard/reset across ticks while it's in flight.
const resetting = new Set<string>();

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

  // Pause requests: abort the in-flight run. Clear the flag either way — a
  // request with no active run (already finished) is a harmless no-op.
  for (const row of rows) {
    if (row.cancelRequestedAt) {
      if (sessionBusy(row.id)) cancelSession(row.id);
      await db
        .update(previewSession)
        .set({ cancelRequestedAt: null, updatedAt: new Date() })
        .where(eq(previewSession.id, row.id));
    }
  }

  // Discard requests: reset the preview branch to production, keep the session
  // live. Deferred a tick if a message is mid-run — resetRequestedAt persists.
  for (const row of rows) {
    if (
      row.resetRequestedAt &&
      LIVE.includes(row.status) &&
      liveSession(row.id) &&
      !sessionBusy(row.id) &&
      !resetting.has(row.id)
    ) {
      resetting.add(row.id);
      void resetSession(row).finally(() => resetting.delete(row.id));
    }
  }

  await pumpMessages();
};

/**
 * Warns sessions nearing the idle TTL, then pauses those past it. Idleness is
 * measured from lastActivityAt, bumped by user messages and by the hub's
 * open-tab heartbeat — so a session winds down ~TTL after the tab closes.
 * Pausing (not expiring) keeps the row, branch, and workspace revivable.
 */
export const sweepIdle = async () => {
  const now = Date.now();
  const killCutoff = new Date(now - previewConfig.idleMinutes * 60_000);
  const warnAfterMs =
    Math.max(0, previewConfig.idleMinutes - previewConfig.idleWarnMinutes) *
    60_000;
  const warnCutoff = new Date(now - warnAfterMs);

  // Warn the band that is idle enough to warn but not yet idle enough to kill,
  // and that hasn't already been warned since its last activity.
  const toWarn = await db
    .select()
    .from(previewSession)
    .where(
      and(
        inArray(previewSession.status, LIVE),
        lt(previewSession.lastActivityAt, warnCutoff),
        gte(previewSession.lastActivityAt, killCutoff),
        or(
          isNull(previewSession.idleWarnedAt),
          lt(previewSession.idleWarnedAt, previewSession.lastActivityAt)
        )
      )
    );
  for (const row of toWarn) {
    const expiresAt = new Date(
      row.lastActivityAt.getTime() + previewConfig.idleMinutes * 60_000
    );
    await emitEvent(row.id, 'session-idle-warning', {
      expiresAt: expiresAt.toISOString(),
    });
    await db
      .update(previewSession)
      .set({ idleWarnedAt: new Date() })
      .where(eq(previewSession.id, row.id));
  }

  const toKill = await db
    .select()
    .from(previewSession)
    .where(
      and(
        inArray(previewSession.status, LIVE),
        lt(previewSession.lastActivityAt, killCutoff)
      )
    );
  for (const row of toKill) {
    await pauseSession(row.id);
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
