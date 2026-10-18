import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '@/db';
import { previewMessage, previewSession } from '@/db/schema';
import { findSessionForbiddenPaths } from '../worker/guardrails';
import { aiUnavailableReason } from './ai-availability';
import {
  commitTitle,
  countToolUses,
  MAX_REPAIR_RUNS,
  REJECTED_MESSAGE,
  verifyChanges,
} from './chat-checks';
import {
  changedFiles,
  commitAndPush,
  discardChanges,
  sanitize,
} from '../worker/git';
import {
  buildAttachmentsBlock,
  loadMessageAttachments,
  planPlacements,
  verifyPlacements,
  type Placed,
} from './attachments';
import type { ClaudeUsage } from './usage';
import { previewConfig } from './config';
import { getGeminiTier } from '@/lib/settings';
import { resolveGeminiKey } from '@/lib/settings-rules';
import { emitEvent, emitEvents } from './events';
import { writeGeminiSystemPrompt } from './gemini-system-prompt';
import { RECAP_MAX_MESSAGES, renderRecap, sanitizeForClient } from './recap';
import { buildRepoContext } from './repo-context';
import { looksLikeUndo, UNDO_REPLY } from './undo-guard';
import { claimsChange, HONESTY_REPAIR_PROMPT } from './honesty';
import { findAmbiguity } from './ambiguity';
import {
  refersToEarlierItem,
  refersToPrevious,
  withPreviousRequest,
  withRecentRequests,
} from './same-as-before';
import { isVagueStylingRequest, VAGUE_REPLY } from './vague-guard';
import { isQuotaError, QUOTA_MESSAGE } from './provider-errors';
import {
  collectionHints,
  duplicateNote,
  findCollectionEntries,
  siteWideNote,
  todayLine,
} from './request-notes';
import { runSessionClaude } from './run-session-claude';
import { runSessionGemini } from './run-session-gemini';
import { liveSession } from './sessions';
import {
  carrySkillFromPrevious,
  bareSkillRequest,
  buildSkillBlock,
  loadSkill,
  parseSkillInvocation,
  scrubSkillJargon,
} from './skills';
import { addUsage, resolveMessageCost } from './usage';
import {
  collectPinned,
  isStaleResumeError,
  pagePathFromContext,
  parseSourceRef,
} from './prompt-context';

type MessageRow = typeof previewMessage.$inferSelect;

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};

// One Claude run per session at a time; other sessions' messages run in
// parallel with it.
const running = new Set<string>();

// Abort handle for the in-flight run of each session, so a user "pause" can
// stop it mid-run. Set while a message runs, cleared when it finishes.
const controllers = new Map<string, AbortController>();

/** Pause the session's in-flight AI run, if any. Returns whether one existed. */
export const cancelSession = (sessionId: string): boolean => {
  const controller = controllers.get(sessionId);
  if (!controller) return false;
  controller.abort();
  return true;
};

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

/** The owner's last few finished requests, newest first. */
const recentUserContents = async (
  sessionId: string,
  beforeMessageId: number,
  limit: number
): Promise<string[]> => {
  const rows = await db
    .select({ content: previewMessage.content })
    .from(previewMessage)
    .where(
      and(
        eq(previewMessage.sessionId, sessionId),
        eq(previewMessage.role, 'user'),
        lt(previewMessage.id, beforeMessageId),
        eq(previewMessage.status, 'done')
      )
    )
    .orderBy(desc(previewMessage.id))
    .limit(limit);
  return rows.map((row) => row.content);
};

/** The owner's previous finished message (for skill carry-over). */
const previousUserContent = async (
  sessionId: string,
  beforeMessageId: number
): Promise<string | null> => {
  const [row] = await db
    .select({ content: previewMessage.content })
    .from(previewMessage)
    .where(
      and(
        eq(previewMessage.sessionId, sessionId),
        eq(previewMessage.role, 'user'),
        lt(previewMessage.id, beforeMessageId),
        eq(previewMessage.status, 'done')
      )
    )
    .orderBy(desc(previewMessage.id))
    .limit(1);
  return row?.content ?? null;
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

  // Gemini key tier (free/paid) is read live per message from the per-repo
  // gemini_tier setting (no session column — the key choice can't corrupt
  // resume state, which gemini doesn't use). Undefined for Claude.
  let geminiApiKey: string | undefined;
  let geminiTier: 'free' | 'paid' | undefined;
  if (provider === 'gemini') {
    const resolved = resolveGeminiKey({
      tier: await getGeminiTier(sessionRow.repoId),
      freeKey: previewConfig.geminiApiKey,
      paidKey: previewConfig.geminiApiKeyPaid,
    });
    geminiApiKey = resolved.key;
    geminiTier = resolved.tier;
  }

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

  // Undo / revert is manual (header Changes dialog → Revert per file): the
  // AI never reconstructs old content from memory. Fixed reply, no agent run,
  // no tokens. Skill invocations are exempt — the skill defines their scope.
  // Vague styling wish ("make it pop"): one specific question, no run.
  if (!parseSkillInvocation(row.content) && isVagueStylingRequest(row.content)) {
    await finishMessage(row, { status: 'done' }, VAGUE_REPLY);
    log(`session ${row.sessionId}: message #${row.id} answered by the vague-request guard`);
    return;
  }

  if (!parseSkillInvocation(row.content) && looksLikeUndo(row.content)) {
    await finishMessage(row, { status: 'done' }, UNDO_REPLY);
    log(`session ${row.sessionId}: message #${row.id} answered by the undo guard`);
    return;
  }

  await db
    .update(previewMessage)
    .set({ status: 'running', startedAt: new Date() })
    .where(eq(previewMessage.id, row.id));

  // Abort handle for a user "pause" — passed to every agent run below.
  const cancelController = new AbortController();
  controllers.set(row.sessionId, cancelController);

  // Agent stream events are throttled into batched inserts so a chatty run
  // doesn't hammer Postgres; the SSE route replays them in order regardless.
  // 120ms keeps streamed text feeling smooth/fast (v0-like) without a flush
  // per token.
  let pending: unknown[] = [];
  let toolCalls = 0;
  const onEvent = (event: unknown) => {
    toolCalls += countToolUses(event);
    pending.push(event);
  };
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
    // Repo facts (page → file map, CMS files, image folders) from a cheap fs
    // scan: they feed the Gemini system prompt and pin-by-page below. Rebuilt
    // per message so files added by earlier edits show up.
    const repo = await buildRepoContext(session.dir, session.appDir);
    const systemPromptPath =
      provider === 'gemini'
        ? await writeGeminiSystemPrompt(row.sessionId, repo)
        : undefined;
    // "/skill-name …" messages: Claude's harness expands repo skills itself;
    // for Gemini the supervisor inlines the SKILL.md (see ./skills).
    let skillBlock = '';
    let request = row.content;
    // Parsed for both providers (the reply scrub keys on it); only Gemini
    // gets the body inlined.
    // A bare "/skill" turn asks a question; the owner's next message is the
    // answer and runs under that same skill (Gemini has no conversation
    // memory between messages, so the skill text must be inlined again).
    const previousRequest = await previousUserContent(row.sessionId, row.id);
    const invocation =
      parseSkillInvocation(row.content) ??
      carrySkillFromPrevious(previousRequest, row.content);
    // "Do the same for the resources page": restate the previous request
    // inline (fresh Gemini conversations do not resolve "the same" from the
    // recap). Skills carry their own context.
    if (!invocation && previousRequest && refersToPrevious(row.content)) {
      request = withPreviousRequest(row.content, previousRequest);
    } else if (!invocation && refersToEarlierItem(row.content)) {
      // "update the resource I added earlier": hand over the recent requests
      // so the target is resolved from them, not guessed from the data file.
      request = withRecentRequests(
        row.content,
        await recentUserContents(row.sessionId, row.id, 4)
      );
    }
    if (invocation && provider === 'gemini') {
      const skill = await loadSkill(session.dir, session.appDir, invocation.name);
      if (skill) {
        skillBlock = buildSkillBlock(skill, invocation.rest);
        request = invocation.rest || bareSkillRequest(skill.name);
      }
    }
    const attachments = await loadMessageAttachments(row.id);
    // The hub-supplied page/element context steers the AI straight to the file
    // (fewer tool calls); the client only ever sees `content` in the transcript.
    // Inline the clicked file, or else — for edit-like messages — the page
    // (named in the message or being viewed) plus its content components, so
    // the AI skips the reads. A skill names its own files, so only a clicked
    // element is pinned alongside it.
    const pinned =
      skillBlock && !parseSourceRef(row.context)
        ? null
        : await collectPinned(row.context, session.dir, session.appDir, {
            message: row.content,
            routes: repo.routes,
            hasAttachments: attachments.length > 0,
          });
    const pinnedFile = pinned?.text ?? '';
    // "Change the button text" with several buttons on the page: ask which,
    // never guess (see ./ambiguity). Clicked elements, uploads and skills
    // carry their own target and skip this.
    if (pinned && !pinned.picked && !skillBlock && !attachments.length) {
      const question = findAmbiguity(row.content, pinned.files);
      if (question) {
        await finishMessage(row, { status: 'done' }, question);
        log(`session ${row.sessionId}: message #${row.id} ambiguous target — asked instead of guessing`);
        return;
      }
    }
    // Images the owner attached: the server picks a destination, copies the
    // bytes into the clone now and tells the agent the URL; the agent only
    // adds the reference (see ./attachments).
    const placed: Placed[] = attachments.length
      ? await planPlacements({
          dir: session.dir,
          appDir: session.appDir,
          publicRel: repo.publicRel,
          attachments,
        })
      : [];
    const attachBlock = placed.length ? buildAttachmentsBlock(placed) : '';
    // Server-known facts the model would otherwise discover or guess (see
    // ./request-notes): today's date, which collection file a named entry
    // lives in, duplicate adds, "everywhere" scope. A few tokens, zero calls.
    const entryHits = await findCollectionEntries(session.dir, row.content).catch(() => []);
    const notes = [
      todayLine(),
      collectionHints(entryHits),
      duplicateNote(row.content, entryHits),
      siteWideNote(row.content),
    ]
      .filter(Boolean)
      .join('\n\n');
    const preamble = [row.context, notes, pinnedFile, attachBlock, skillBlock]
      .filter(Boolean)
      .join('\n\n');
    const prompt = preamble ? `${preamble}\n\n---\n\n${request}` : request;
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
      signal: cancelController.signal,
      systemPromptPath,
      geminiApiKey,
      onEvent,
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
        signal: cancelController.signal,
        systemPromptPath,
        geminiApiKey,
        onEvent,
      });
    }

    // User paused mid-run: revert the partial edit and stop cleanly (distinct
    // from a timeout/error — the external abort signal is the tell).
    if (cancelController.signal.aborted) {
      await discardChanges(session.dir);
      await finishMessage(
        row,
        {
          status: 'failed',
          error:
            "You paused this request, so nothing was applied. Send a new request whenever you're ready.",
        },
        null
      );
      return;
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
            : isQuotaError(run.stderr)
              ? QUOTA_MESSAGE
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
    // Reply claims a change, tree says otherwise → one forced repair run:
    // make the edit or answer honestly. Never ship "I've re-added it" over an
    // untouched file (see ./honesty).
    if (!changed.length && claimsChange(resultText)) {
      log(
        `session ${row.sessionId}: message #${row.id} claimed a change with no file modified — honesty repair`
      );
      const honestPrompt = `${HONESTY_REPAIR_PROMPT}\n\nThe owner's request was: "${request}"`;
      const honest = await runAgent({
        cwd: session.dir,
        prompt:
          provider === 'gemini' && preamble
            ? `${preamble}\n\n---\n\n${honestPrompt}`
            : honestPrompt,
        claudeSessionId,
        signal: cancelController.signal,
        systemPromptPath,
        geminiApiKey,
        onEvent,
      });
      usage = addUsage(usage, honest.usage, !costIsCumulative);
      if (honest.gotResult && honest.claudeSessionId) {
        claudeSessionId = honest.claudeSessionId;
      }
      if (cancelController.signal.aborted) {
        await discardChanges(session.dir);
        await finishMessage(
          row,
          {
            status: 'failed',
            error:
              "You paused this request, so nothing was applied. Send a new request whenever you're ready.",
          },
          null
        );
        return;
      }
      if (!honest.timedOut && honest.exitCode === 0 && honest.resultText) {
        resultText = honest.resultText;
      }
      changed = await changedFiles(session.dir);
    }
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

    // Verify the change didn't break the preview (invalid JSON, page 500s)
    // and, when images were attached, that each one is referenced; if not,
    // feed the problem back to the agent and let it repair — the client
    // shouldn't have to paste stack traces into the chat.
    if (changed.length || placed.length) {
      const pagePath = pagePathFromContext(row.context);
      type Problem = { kind: 'placement' | 'verify'; text: string };
      const check = async (): Promise<Problem | null> => {
        if (placed.length) {
          const placement = await verifyPlacements({
            dir: session.dir,
            placed,
            changed,
          });
          if (placement) return { kind: 'placement', text: placement };
        }
        if (!changed.length) return null;
        const verify = await verifyChanges(
          session.dir,
          session.port,
          changed,
          pagePath
        );
        return verify ? { kind: 'verify', text: verify } : null;
      };
      let problem = await check();
      for (
        let attempt = 1;
        problem && attempt <= MAX_REPAIR_RUNS;
        attempt++
      ) {
        log(
          `session ${row.sessionId}: ${problem.kind === 'placement' ? 'upload not placed' : 'preview broken'} after edit (repair ${attempt}/${MAX_REPAIR_RUNS}) — ${problem.text.slice(0, 200)}`
        );
        const repairPrompt =
          problem.kind === 'placement'
            ? `Automated check: the uploaded image(s) are not used on the site yet.\n\n${problem.text}\n\nFix this now: reference each image by its exact URL path in the component or CMS JSON where the owner asked for it. The image files already exist — do not open, search for, move or create them. Do not ask questions.`
            : `Automated check: your last change broke the live preview.\n\n${problem.text}\n\nFix this now. Keep the requested change if possible, but the preview must render again. Do not ask questions — just repair it.`;
        const repair = await runAgent({
          cwd: session.dir,
          // Repair runs are fresh Gemini conversations too: give them the
          // pinned context again so they don't rediscover the file.
          prompt: provider === 'gemini' && preamble ? `${preamble}\n\n---\n\n${repairPrompt}` : repairPrompt,
          claudeSessionId,
          signal: cancelController.signal,
          systemPromptPath,
          geminiApiKey,
          onEvent,
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
        problem = await check();
      }
      if (problem) {
        log(
          `session ${row.sessionId}: still ${problem.kind === 'placement' ? 'unplaced' : 'broken'} after ${MAX_REPAIR_RUNS} repairs — reverting`
        );
        await persistClaudeSessionId();
        await discardChanges(session.dir);
        // The site owner asked to see the real error, so the client-facing
        // message carries it (sanitized, capped) behind a plain-language why.
        const why =
          problem.kind === 'placement'
            ? 'The change was undone because the uploaded image could not be placed on the site.'
            : problem.text.includes('is no longer valid JSON')
              ? 'The change was undone because it made a content file invalid, which would have broken the site.'
              : 'The change was undone because a page on your site stopped loading after it was applied.';
        const detail = sanitizeForClient(problem.text, session.dir).slice(0, 500);
        // reply=null — the error row already carries the message; a matching
        // assistant bubble would just duplicate it in the transcript.
        await finishMessage(
          row,
          {
            status: 'failed',
            error: `${why}\n\nThe error was: ${detail}\n\nNothing was applied to your site. You can try again, or share this error with your developer.`,
            errorDetail: sanitize(problem.text),
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
      sha = await commitAndPush({
        dir: session.dir,
        branch: sessionRow.branch,
        message: `AI session edit: ${commitTitle(row.content)}`,
      });
      await emitEvent(row.sessionId, 'commit', { sha, files: changed }, row.id);
    }

    await finishMessage(
      row,
      { status: 'done', commitSha: sha, ...usage },
      scrubSkillJargon(resultText, invocation?.name ?? null) || 'Done.',
      costIsCumulative
    );
    log(
      `session ${row.sessionId}: message #${row.id} done${sha ? ` — ${sha.slice(0, 7)}` : ' (no changes)'} [${provider}${geminiTier ? `/${geminiTier}` : ''} tools=${toolCalls} in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'}]`
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
    controllers.delete(row.sessionId);
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
