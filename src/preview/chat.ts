import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import { findSessionForbiddenPaths } from '../worker/guardrails';
import { aiUnavailableReason } from './ai-availability';
import { changedFiles, commitAndPush, discardChanges, sanitize } from '../worker/git';
import type { ClaudeUsage } from '../worker/runner';
import { previewConfig } from './config';
import { emitEvent, emitEvents } from './events';
import { RECAP_MAX_MESSAGES, renderRecap, sanitizeForClient } from './recap';
import { runSessionClaude } from './run-session-claude';
import { runSessionGemini } from './run-session-gemini';
import { liveSession } from './sessions';
import { addUsage, resolveMessageCost } from './usage';
import {
  buildPinnedFile,
  isStaleResumeError,
  pagePathFromContext,
} from './prompt-context';

type MessageRow = typeof previewMessage.$inferSelect;

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};

// One Claude run per session at a time; other sessions' messages run in
// parallel with it.
const running = new Set<string>();

const REJECTED_MESSAGE =
  'Thanks for your request! That change touched files the editor must not modify, so it was not applied. Please reach out to your developer and they will be happy to help.';

/** Self-repair attempts when a change breaks the preview before giving up. */
const MAX_REPAIR_RUNS = 2;

/**
 * Replays the durable DB transcript into the prompt when the CLI-side
 * conversation is gone (stale --resume target, killed first run). Only
 * finished turns — a queued/running row is the message being processed.
 */
const buildRecap = async (
  sessionId: string,
  beforeMessageId: number
): Promise<string | null> => {
  const rows = await db
    .select({
      role: previewMessage.role,
      content: previewMessage.content,
      status: previewMessage.status,
      error: previewMessage.error,
    })
    .from(previewMessage)
    .where(
      and(
        eq(previewMessage.sessionId, sessionId),
        lt(previewMessage.id, beforeMessageId),
        inArray(previewMessage.status, ['done', 'failed', 'rejected'])
      )
    )
    .orderBy(desc(previewMessage.id))
    .limit(RECAP_MAX_MESSAGES);
  return renderRecap(rows.reverse());
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
  const checkPage = async (path: string): Promise<string | null> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status >= 500) {
        const body = await res.text().catch(() => '');
        return `GET ${path} now returns ${res.status}. Dev server error: ${stripHtml(body).slice(0, 600)}`;
      }
    } catch {
      // Transient dev-server hiccup (restart, timeout) — don't block the
      // commit on infrastructure noise; only concrete errors trigger a repair.
    }
    return null;
  };
  const problem = await checkPage(pagePath);
  if (problem) return problem;
  // Site-wide CMS files feed every page — a break there can miss the page the
  // client is viewing, so also probe the home page. Other routes stay
  // unchecked (known limitation; a full crawl per edit is too slow).
  const touchedSharedCms = changed.some(
    (file) =>
      /(^|\/)(_site|_pages)\.json$/.test(file) || /(^|\/)_collections\//.test(file)
  );
  if (touchedSharedCms && pagePath !== '/') {
    return checkPage('/');
  }
  return null;
};

const finishMessage = async (
  row: MessageRow,
  fields: Partial<MessageRow>,
  reply: string | null,
  // Claude's total_cost_usd is CUMULATIVE for the resumed conversation; Gemini
  // reports the per-message cost directly. Default cumulative (claude).
  costIsCumulative = true
) => {
  if (typeof fields.costUsd === 'number') {
    const [session] = await db
      .select({ claudeCostUsd: previewSession.claudeCostUsd })
      .from(previewSession)
      .where(eq(previewSession.id, row.sessionId));
    const { messageCost, newSessionTotal } = resolveMessageCost(
      fields.costUsd,
      session?.claudeCostUsd ?? 0,
      costIsCumulative
    );
    fields = { ...fields, costUsd: messageCost };
    await db
      .update(previewSession)
      .set({ claudeCostUsd: newSessionTotal })
      .where(eq(previewSession.id, row.sessionId));
  }
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
  // Running a message is activity — bump the session so a long edit isn't
  // reaped mid-run, and clear any pending idle warning.
  await db
    .update(previewSession)
    .set({ lastActivityAt: new Date(), idleWarnedAt: null })
    .where(eq(previewSession.id, row.sessionId));

  const [sessionRow] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, row.sessionId));
  if (!sessionRow) return;
  // The session enters the live map before its dev server finishes booting.
  // Hold the message in `queued` until the session is actually ready so the
  // verify step's page probe has a server to hit; the next tick retries.
  if (sessionRow.status !== 'ready' && sessionRow.status !== 'restarting') {
    return;
  }

  // Provider is bound at session creation; every message in the session runs
  // on the same agent (resume ids + cost accounting are provider-specific).
  const provider = sessionRow.provider;
  const runAgent =
    provider === 'gemini' ? runSessionGemini : runSessionClaude;
  const costIsCumulative = provider === 'claude';

  // Previews run without an AI key; chat can't. Fail instantly with a clear
  // reason instead of letting the agent retry a missing/bad key for minutes.
  const aiDown = aiUnavailableReason(provider);
  if (aiDown) {
    await finishMessage(
      row,
      { status: 'failed', error: `${aiDown} The preview itself still works — contact your developer to enable AI editing.` },
      null
    );
    return;
  }

  await db
    .update(previewMessage)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(previewMessage.id, row.id));

  // Agent stream events are throttled into batched inserts so a chatty run
  // doesn't hammer Postgres; the SSE route replays them in order regardless.
  // 120ms keeps streamed text feeling smooth/fast (v0-like) without a flush
  // per token.
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
  }, 120);

  try {
    // The hub-supplied page/element context steers the AI straight to the file
    // (fewer tool calls); the client only ever sees `content` in the transcript.
    // For element picks, inline the clicked file so the AI skips the reads.
    const pinnedFile = await buildPinnedFile(
      row.context,
      session.dir,
      session.appDir
    );
    const prompt = row.context
      ? `${row.context}${pinnedFile ? `\n\n${pinnedFile}` : ''}\n\n---\n\n${row.content}`
      : row.content;
    // No resumable CLI session but prior finished messages exist (e.g. the
    // first run was killed before writing its transcript) — replay the DB
    // transcript so the fresh run keeps the conversation.
    const withRecap = async (base: string) => {
      const recap = await buildRecap(row.sessionId, row.id);
      return recap ? `${recap}\n\n---\n\n${base}` : base;
    };

    // Gemini's --resume re-sends the ENTIRE growing chat history every message
    // (its implicit caching only discounts price, not the tokens sent/metered),
    // so a long session's per-message input balloons (a 14th message hit ~313k
    // for a one-line edit; baseline is ~13k). The idiomatic fix for serial
    // independent edits is to NOT resume — run each message as a fresh
    // conversation and rely on the DB recap for continuity, keeping every
    // message near baseline. Claude caches history cheaply + resumes well, so
    // it keeps resuming.
    const resumeId = provider === 'gemini' ? null : sessionRow.claudeSessionId;

    let run = await runAgent({
      cwd: session.dir,
      prompt: resumeId ? prompt : await withRecap(prompt),
      claudeSessionId: resumeId,
      onEvent: (event) => {
        pending.push(event);
      },
    });

    // A --resume target can vanish (container recreated, CLI state pruned) —
    // retry once without it, replaying the DB transcript as a recap so the
    // conversation survives. No proactive resume validation: this reactive
    // retry is the intended recovery path.
    if (
      !run.timedOut &&
      run.exitCode !== 0 &&
      resumeId &&
      isStaleResumeError(run.stderr)
    ) {
      log(
        `session ${row.sessionId}: stale ${provider} session ${sessionRow.claudeSessionId} — retrying fresh with recap`
      );
      run = await runAgent({
        cwd: session.dir,
        prompt: await withRecap(prompt),
        claudeSessionId: null,
        onEvent: (event) => {
          pending.push(event);
        },
      });
    }

    // Accumulated across the initial run and any self-repair runs below.
    let usage = { ...run.usage };
    // A run that never emitted `result` (SIGKILL on timeout) may not have
    // written its transcript — persisting its session id would point the next
    // message's --resume at a conversation that doesn't exist. Keep the last
    // known-good target instead.
    let claudeSessionId = run.gotResult
      ? run.claudeSessionId
      : sessionRow.claudeSessionId;
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
      log(
        `session ${row.sessionId}: message #${row.id} ${provider} ${
          run.timedOut ? 'timed out' : `exited ${run.exitCode}`
        } — ${sanitize(run.stderr).slice(0, 300) || '(no stderr)'}`
      );
      await persistClaudeSessionId();
      // Invariant: between messages the working tree equals the branch, so the
      // preview never shows edits that publish would not ship.
      await discardChanges(session.dir);
      const stderrForClient = sanitizeForClient(run.stderr, session.dir).slice(
        0,
        300
      );
      await finishMessage(
        row,
        {
          status: 'failed',
          error: run.timedOut
            ? `The edit took too long and was stopped after ${Math.round(previewConfig.messageTimeoutMs / 60000)} minutes, so nothing was applied. Please try a smaller or simpler request.`
            : stderrForClient
              ? `The AI could not complete this request, so nothing was applied.\n\nThe error was: ${stderrForClient}\n\nYou can try again, or share this error with your developer.`
              : 'The AI could not complete this request. Please try again.',
          errorDetail: sanitize(run.stderr) || null,
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
        const repair = await runAgent({
          cwd: session.dir,
          prompt: `Automated check: your last change broke the live preview.\n\n${problem}\n\nFix this now. Keep the requested change if possible, but the preview must render again. Do not ask questions — just repair it.`,
          claudeSessionId,
          onEvent: (event) => {
            pending.push(event);
          },
        });
        usage = addUsage(usage, repair.usage, !costIsCumulative);
        if (repair.gotResult && repair.claudeSessionId) {
          claudeSessionId = repair.claudeSessionId;
        }
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
        // The site owner asked to see the real error, so the client-facing
        // message carries it (sanitized, capped) behind a plain-language why.
        const why = problem.includes('is no longer valid JSON')
          ? 'The change was undone because it made a content file invalid, which would have broken the site.'
          : 'The change was undone because a page on your site stopped loading after it was applied.';
        const detail = sanitizeForClient(problem, session.dir).slice(0, 500);
        // reply=null — the error row already carries the message; a matching
        // assistant bubble would just duplicate it in the transcript.
        await finishMessage(
          row,
          {
            status: 'failed',
            error: `${why}\n\nThe error was: ${detail}\n\nNothing was applied to your site. You can try rephrasing the request, or share this error with your developer.`,
            errorDetail: sanitize(problem),
            ...usage,
          },
          null,
          costIsCumulative
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
      resultText || 'Done.',
      costIsCumulative
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
        error: `The change could not be completed. The error was: ${sanitizeForClient(message, session.dir).slice(0, 300)}\n\nNothing was applied to your site. You can try again, or share this error with your developer.`,
        errorDetail: message,
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
