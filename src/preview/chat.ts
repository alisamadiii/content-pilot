import { and, asc, eq } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import { findSessionForbiddenPaths } from '../worker/guardrails';
import { changedFiles, commitAndPush, discardChanges, sanitize } from '../worker/git';
import type { ClaudeUsage } from '../worker/runner';
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

const BROKE_PREVIEW_MESSAGE =
  'That change broke the site preview, so it was undone — nothing was applied. Please try phrasing the request differently, or reach out to your developer.';

/** Self-repair attempts when a change breaks the preview before giving up. */
const MAX_REPAIR_RUNS = 2;

/** Sums per-run AI usage across the initial run + repair runs. */
const addUsage = (a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage => ({
  model: b.model ?? a.model,
  inputTokens:
    a.inputTokens === null && b.inputTokens === null
      ? null
      : (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens:
    a.outputTokens === null && b.outputTokens === null
      ? null
      : (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  costUsd:
    a.costUsd === null && b.costUsd === null
      ? null
      : (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

/** The page the client is viewing, from the hub-supplied message context. */
const pagePathFromContext = (context: string | null): string => {
  const match = context?.match(/editing this page: (\S+)/);
  if (!match) return '/';
  try {
    return new URL(match[1]).pathname || '/';
  } catch {
    return match[1].startsWith('/') ? match[1] : '/';
  }
};

const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Post-edit verification: a change must not leave the preview broken. Returns a
 * problem description Claude can act on, or null when the change looks healthy.
 * Two checks: changed .json files must still parse (the CMS contract is JSON —
 * one stray comma 500s every page reading it), and the page the client is
 * viewing must still render on the dev server.
 */
const verifyChanges = async (
  dir: string,
  port: number,
  changed: string[],
  pagePath: string
): Promise<string | null> => {
  for (const file of changed) {
    if (!file.endsWith('.json')) continue;
    try {
      JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch (error) {
      return `${file} is no longer valid JSON: ${(error as Error).message}`;
    }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pagePath}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 500) {
      const body = await res.text().catch(() => '');
      return `GET ${pagePath} now returns ${res.status}. Dev server error: ${stripHtml(body).slice(0, 600)}`;
    }
  } catch {
    // Transient dev-server hiccup (restart, timeout) — don't block the commit
    // on infrastructure noise; only concrete errors trigger a repair.
  }
  return null;
};

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
    // The hub-supplied page/element context steers the AI straight to the file
    // (fewer tool calls); the client only ever sees `content` in the transcript.
    const prompt = row.context
      ? `${row.context}\n\n---\n\n${row.content}`
      : row.content;
    const run = await runSessionClaude({
      cwd: session.dir,
      prompt,
      claudeSessionId: sessionRow.claudeSessionId,
      onEvent: (event) => {
        pending.push(event);
      },
    });

    // Accumulated across the initial run and any self-repair runs below.
    let usage = { ...run.usage };
    let claudeSessionId = run.claudeSessionId;
    let resultText = run.resultText;

    const persistClaudeSessionId = async () => {
      if (claudeSessionId && claudeSessionId !== sessionRow.claudeSessionId) {
        await db
          .update(previewSession)
          .set({ claudeSessionId, updatedAt: new Date() })
          .where(eq(previewSession.id, row.sessionId));
      }
    };

    if (run.timedOut || run.exitCode !== 0) {
      await persistClaudeSessionId();
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
          ...usage,
        },
        null
      );
      return;
    }

    let changed = await changedFiles(session.dir);
    const rejectForbidden = async (forbidden: string[]) => {
      log(`session ${row.sessionId}: denylist hit — ${forbidden.join(', ')}`);
      await persistClaudeSessionId();
      await discardChanges(session.dir);
      await finishMessage(
        row,
        { status: 'rejected', error: REJECTED_MESSAGE, ...usage },
        REJECTED_MESSAGE
      );
    };
    const forbidden = findSessionForbiddenPaths(changed);
    if (forbidden.length) {
      await rejectForbidden(forbidden);
      return;
    }

    // Verify the change didn't break the preview (invalid JSON, page 500s);
    // if it did, feed the error back to Claude and let it repair — the client
    // shouldn't have to paste stack traces into the chat.
    if (changed.length) {
      const pagePath = pagePathFromContext(row.context);
      let problem = await verifyChanges(
        session.dir,
        session.port,
        changed,
        pagePath
      );
      for (
        let attempt = 1;
        problem && attempt <= MAX_REPAIR_RUNS;
        attempt++
      ) {
        log(
          `session ${row.sessionId}: preview broken after edit (repair ${attempt}/${MAX_REPAIR_RUNS}) — ${problem.slice(0, 200)}`
        );
        const repair = await runSessionClaude({
          cwd: session.dir,
          prompt: `Automated check: your last change broke the live preview.\n\n${problem}\n\nFix this now. Keep the requested change if possible, but the preview must render again. Do not ask questions — just repair it.`,
          claudeSessionId,
          onEvent: (event) => {
            pending.push(event);
          },
        });
        usage = addUsage(usage, repair.usage);
        if (repair.claudeSessionId) claudeSessionId = repair.claudeSessionId;
        if (repair.resultText) resultText = repair.resultText;
        if (repair.timedOut || repair.exitCode !== 0) break;
        changed = await changedFiles(session.dir);
        const forbiddenNow = findSessionForbiddenPaths(changed);
        if (forbiddenNow.length) {
          await rejectForbidden(forbiddenNow);
          return;
        }
        problem = await verifyChanges(
          session.dir,
          session.port,
          changed,
          pagePath
        );
      }
      if (problem) {
        log(
          `session ${row.sessionId}: still broken after ${MAX_REPAIR_RUNS} repairs — reverting`
        );
        await persistClaudeSessionId();
        await discardChanges(session.dir);
        await finishMessage(
          row,
          { status: 'failed', error: BROKE_PREVIEW_MESSAGE, ...usage },
          BROKE_PREVIEW_MESSAGE
        );
        return;
      }
    }

    await persistClaudeSessionId();

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
      { status: 'done', commitSha: sha, ...usage },
      resultText || 'Done.'
    );
    log(
      `session ${row.sessionId}: message #${row.id} done${sha ? ` — ${sha.slice(0, 7)}` : ' (no changes)'}`
    );
  } catch (error) {
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
  } finally {
    // Lives until here so repair runs stream their activity live too.
    clearInterval(flusher);
    if (pending.length) await flush();
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
