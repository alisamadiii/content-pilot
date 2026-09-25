import { client, db } from '@/db';
import { previewEvent, type PreviewEventType } from '@/db/schema';

/**
 * Persists one session event and pings SSE listeners. Rows are the SSE
 * backing store — the events route replays them by id (Last-Event-ID), so a
 * dropped connection never loses events.
 */
export const emitEvent = async (
  sessionId: string,
  type: PreviewEventType,
  data: unknown,
  messageId?: number
) => {
  await db.insert(previewEvent).values({
    sessionId,
    messageId: messageId ?? null,
    type,
    data: JSON.stringify(data),
  });
  try {
    await client.notify('cp_preview_events', sessionId);
  } catch {
    // Best-effort; the SSE route also polls as a fallback.
  }
};

/** Bulk variant used by the Claude stream throttle. */
export const emitEvents = async (
  sessionId: string,
  rows: { type: PreviewEventType; data: unknown; messageId?: number }[]
) => {
  if (!rows.length) return;
  await db.insert(previewEvent).values(
    rows.map((row) => ({
      sessionId,
      messageId: row.messageId ?? null,
      type: row.type,
      data: JSON.stringify(row.data),
    }))
  );
  try {
    await client.notify('cp_preview_events', sessionId);
  } catch {
    // Best-effort; the SSE route also polls as a fallback.
  }
};
