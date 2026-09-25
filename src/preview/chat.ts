import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import { findSessionForbiddenPaths } from '../worker/guardrails';
import { changedFiles, commitAndPush, discardChanges, sanitize } from '../worker/git';
import { emitEvent, emitEvents } from './events';
import { runSessionClaude } from './run-session-claude';
import { lastActivity } from './proxy';
import { liveSession } from './sessions';

type MessageRow = typeof previewMessage.$inferSelect;

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};

// One Claude run per session at a time; other sessions' messages run in
// parallel with it.
const running = new Set<string>();

const REJECTED_MESSAGE =
  'Thanks for your request! That change touched files the editor must not modify, so it was not applied. Please reach out to your developer and they will be happy to help.';

const finishMessage = async (
  row: MessageRow,
  fields: Partial<MessageRow>,
  reply: string | null
) => {
  await db
    .update(previewMessage)
    .set({ ...fields, finishedAt: new Date() })
    .where(eq(previewMessage.id, row.id));
  if (reply) {
    await db.insert(previewMessage).values({
      sessionId: row.sessionId,
      role: 'assistant',
      content: reply,
      status: 'done',
    });
  }
  await emitEvent(
    row.sessionId,
    'message-done',
    {
      messageId: row.id,
      status: fields.status,
      commitSha: fields.commitSha ?? null,
      error: fields.error ?? null,
      reply,
    },
    row.id
  );
};

const processMessage = async (row: MessageRow) => {
  const session = liveSession(row.sessionId);
  if (!session) return; // torn down between claim and run
  lastActivity.set(row.sessionId, Date.now());

  const [sessionRow] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, row.sessionId));
  if (!sessionRow) return;

  await db
    .update(previewMessage)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(previewMessage.id, row.id));

  // Claude stream events are throttled into batched inserts so a chatty run
  // doesn't hammer Postgres; the SSE route replays them in order regardless.
  let pending: unknown[] = [];
  const flush = async () => {
    const batch = pending;
    pending = [];
    await emitEvents(
      row.sessionId,
      batch.map((data) => ({ type: 'claude' as const, data, messageId: row.id }))
    );
  };
  const flusher = setInterval(() => {
    if (pending.length) void flush();
  }, 300);

  try {
    const run = await runSessionClaude({
      cwd: session.dir,
      prompt: row.content,
      claudeSessionId: sessionRow.claudeSessionId,
      onEvent: (event) => {
        pending.push(event);
      },
    });
    clearInterval(flusher);
    if (pending.length) await flush();

    if (run.claudeSessionId && run.claudeSessionId !== sessionRow.claudeSessionId) {
      await db
        .update(previewSession)
        .set({ claudeSessionId: run.claudeSessionId, updatedAt: new Date() })
        .where(eq(previewSession.id, row.sessionId));
    }

    if (run.timedOut || run.exitCode !== 0) {
      // Invariant: between messages the working tree equals the branch, so the
      // preview never shows edits that publish would not ship.
      await discardChanges(session.dir);
      await finishMessage(
        row,
        {
          status: 'failed',
          error: run.timedOut
            ? 'The edit took too long and was stopped. Please try a simpler request.'
            : 'The AI could not complete this request. Please try again.',
          ...run.usage,
        },
        null
      );
      return;
    }

    const changed = await changedFiles(session.dir);
    const forbidden = findSessionForbiddenPaths(changed);
    if (forbidden.length) {
      log(`session ${row.sessionId}: denylist hit — ${forbidden.join(', ')}`);
      await discardChanges(session.dir);
      await finishMessage(
        row,
        { status: 'rejected', error: REJECTED_MESSAGE, ...run.usage },
        REJECTED_MESSAGE
      );
      return;
    }

    let sha: string | null = null;
    if (changed.length) {
      const title = row.content.split('\n')[0].slice(0, 72);
      sha = await commitAndPush({
        dir: session.dir,
        branch: sessionRow.branch,
        message: `AI session edit: ${title}`,
      });
      await emitEvent(row.sessionId, 'commit', { sha, files: changed }, row.id);
    }

    await finishMessage(
      row,
      { status: 'done', commitSha: sha, ...run.usage },
      run.resultText || 'Done.'
    );
    log(
      `session ${row.sessionId}: message #${row.id} done${sha ? ` — ${sha.slice(0, 7)}` : ' (no changes)'}`
    );
  } catch (error) {
    clearInterval(flusher);
    const message = sanitize((error as Error).message || 'unknown error');
    log(`session ${row.sessionId}: message #${row.id} crashed — ${message}`);
    try {
      await discardChanges(session.dir);
    } catch {
      // best effort
    }
    await finishMessage(
      row,
      {
        status: 'failed',
        error: `The change could not be completed: ${message.slice(0, 300)}`,
      },
      null
    );
  }
};

/** Claims and runs queued messages — one in flight per session. */
export const pumpMessages = async () => {
  const queued = await db
    .select()
    .from(previewMessage)
    .where(
      and(eq(previewMessage.status, 'queued'), eq(previewMessage.role, 'user'))
    )
    .orderBy(asc(previewMessage.id));

  for (const row of queued) {
    if (running.has(row.sessionId)) continue;
    if (!liveSession(row.sessionId)) continue;
    running.add(row.sessionId);
    void processMessage(row)
      .catch((error) => log(`pump crash: ${sanitize(String(error))}`))
      .finally(() => running.delete(row.sessionId));
  }
};

export const sessionBusy = (sessionId: string) => running.has(sessionId);
