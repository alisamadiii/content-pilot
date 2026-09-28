import { execFile } from 'child_process';
import { eq } from 'drizzle-orm';
import { promisify } from 'util';
import { client, db } from '@/db';
import { job, type JobStatus } from '@/db/schema';
import { claimBatch, recoverStaleJobs } from './claim';
import { config, ensureWorkspace } from './config';
import {
  changedFiles,
  commitAndPush,
  discardChanges,
  sanitize,
  syncRepo,
} from './git';
import {
  buildBatchPrompt,
  buildPromptSegments,
  findForbiddenPaths,
  parseVerdicts,
  type Verdict,
} from './guardrails';
import { runClaude, type ClaudeRun, type ClaudeUsage } from './runner';
import { runTypecheck } from './typecheck';
import { dispatchJobWebhooks } from './webhooks';

// A broken edit gets a couple of self-repair passes (compiler output fed back
// to Claude) before we give up and revert — mirrors the preview path's budget.
const MAX_TYPECHECK_REPAIRS = 2;

/** Accumulate repair-run token/cost into the lead's usage, in place. */
const addUsage = (into: ClaudeUsage, extra: ClaudeUsage) => {
  into.inputTokens = (into.inputTokens ?? 0) + (extra.inputTokens ?? 0);
  into.outputTokens = (into.outputTokens ?? 0) + (extra.outputTokens ?? 0);
  into.costUsd = (into.costUsd ?? 0) + (extra.costUsd ?? 0);
  into.model = into.model ?? extra.model;
};

const buildTypecheckRepairPrompt = (output: string) =>
  `Automated check: your last change did not pass the project's typecheck/build. ` +
  `Fix the errors below without changing the intended behaviour of the edit. ` +
  `If a symbol is used but undefined (e.g. a field read from data but missing ` +
  `from its schema, or a missing import), add it in the correct place. ` +
  `Do not ask questions — just repair it.\n\n${output}`;

const execFileAsync = promisify(execFile);

type Job = Awaited<ReturnType<typeof claimBatch>>[number];

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

const finishJob = async (
  id: number,
  fields: Partial<{
    status: JobStatus;
    error: string | null;
    resultSummary: string | null;
    commitSha: string | null;
    logs: string | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  }>
) => {
  await db
    .update(job)
    .set({ ...fields, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(job.id, id));
  // Fire webhooks for the terminal transition. Re-read so the payload carries
  // the full, fresh row (owner/repo/repoId/error/…). Best-effort; never throws.
  const [full] = await db.select().from(job).where(eq(job.id, id));
  if (full) {
    await dispatchJobWebhooks(full);
  }
};

/** Fails every job in the batch with the same client-facing message. */
const failBatch = async (jobs: Job[], error: string, run?: ClaudeRun) => {
  const lead = jobs[0];
  for (const row of jobs) {
    await finishJob(row.id, {
      status: 'failed',
      error,
      logs:
        row.id === lead.id
          ? (run?.logs ?? null)
          : `processed in batch with job #${lead.id}`,
      ...(row.id === lead.id && run ? run.usage : {}),
    });
  }
};

const processBatch = async (jobs: Job[]) => {
  const lead = jobs[0];
  const ids = jobs.map((row) => row.id);
  log(
    `batch #${lead.id} (${jobs.length} job${jobs.length > 1 ? 's' : ''}): ${lead.owner}/${lead.repo} — ids ${ids.join(', ')}`
  );

  const dir = await syncRepo(lead);

  // Persist the exact input we send to Claude (guardrail skill + batch prompt)
  // as segments on the lead, so the dashboard can show it before the run ends.
  await db
    .update(job)
    .set({
      promptSent: JSON.stringify(buildPromptSegments(jobs)),
      updatedAt: new Date(),
    })
    .where(eq(job.id, lead.id));

  const run = await runClaude({
    cwd: dir,
    prompt: buildBatchPrompt(jobs),
    // Batches are claimed mode-pure (see claimBatch), so the lead's flag
    // speaks for the whole batch.
    unrestricted: lead.unrestricted,
    onLog: (logs) => {
      void db
        .update(job)
        .set({ logs, updatedAt: new Date() })
        .where(eq(job.id, lead.id))
        .then(
          () => {},
          () => {}
        );
    },
  });

  log(
    `batch #${lead.id}: claude exited (model ${run.usage.model ?? '?'}, in ${run.usage.inputTokens ?? '?'} / out ${run.usage.outputTokens ?? '?'} tokens, $${run.usage.costUsd ?? '?'})`
  );

  if (run.timedOut) {
    await discardChanges(dir);
    await failBatch(
      jobs,
      'The edit took too long and was stopped. Please try a simpler request.',
      run
    );
    return;
  }

  const verdicts = parseVerdicts(run.resultText, ids);
  if (!verdicts) {
    await discardChanges(dir);
    await failBatch(
      jobs,
      'The AI did not produce a valid result. Please try again.',
      run
    );
    return;
  }

  const byId = new Map<number, Verdict>(
    verdicts.map((verdict) => [verdict.id, verdict])
  );
  const doneIds = verdicts
    .filter((verdict) => verdict.status === 'done')
    .map((verdict) => verdict.id);

  const changed = doneIds.length ? await changedFiles(dir) : [];
  // Unrestricted (admin-approved) batches skip the structural denylist but
  // keep the secrets floor — .env and friends never get committed.
  const forbidden = findForbiddenPaths(changed, {
    unrestricted: lead.unrestricted,
  });

  // done-verdicts but nothing/forbidden on disk → downgrade those rows.
  let downgradeError: string | null = null;
  if (doneIds.length && !changed.length) {
    downgradeError =
      'The AI reported success but made no changes. Please rephrase your request.';
  } else if (forbidden.length) {
    downgradeError =
      'Thanks for your request! This change goes a bit beyond what the automatic editor can do on its own, so it was not applied. Please reach out to your developer and they will be happy to help.';
    log(`batch #${lead.id}: denylist hit — ${forbidden.join(', ')}`);
  }

  let sha: string | null = null;
  if (doneIds.length && !downgradeError) {
    // Typecheck gate: never ship an edit that breaks the build. On failure,
    // feed the compiler output back to Claude and let it self-repair; if it
    // still fails after the budget, revert and fail the batch. A repo with no
    // typecheck script is skipped (see runTypecheck) so nothing is blocked.
    let tc = await runTypecheck(dir, lead.repoId);
    for (
      let attempt = 1;
      tc.status === 'fail' && attempt <= MAX_TYPECHECK_REPAIRS;
      attempt++
    ) {
      log(
        `batch #${lead.id}: typecheck failed (repair ${attempt}/${MAX_TYPECHECK_REPAIRS})`
      );
      const repair = await runClaude({
        cwd: dir,
        prompt: buildTypecheckRepairPrompt(tc.output),
        unrestricted: lead.unrestricted,
        onLog: (logs) => {
          void db
            .update(job)
            .set({ logs, updatedAt: new Date() })
            .where(eq(job.id, lead.id))
            .then(
              () => {},
              () => {}
            );
        },
      });
      addUsage(run.usage, repair.usage);
      if (repair.timedOut) break;
      // A repair could wander into a forbidden path — re-check before trusting
      // it. If it did, stop (tc stays 'fail') and let the revert path handle it.
      const forbiddenNow = findForbiddenPaths(await changedFiles(dir), {
        unrestricted: lead.unrestricted,
      });
      if (forbiddenNow.length) {
        log(
          `batch #${lead.id}: denylist hit during repair — ${forbiddenNow.join(', ')}`
        );
        break;
      }
      tc = await runTypecheck(dir, lead.repoId);
    }

    if (tc.status === 'skip') {
      log(`batch #${lead.id}: typecheck skipped — ${tc.reason}`);
    }

    if (tc.status === 'fail') {
      log(`batch #${lead.id}: typecheck still failing — reverting`);
      await discardChanges(dir);
      downgradeError =
        'This change was undone because it introduced an error that would have broken the site. Please try rephrasing your request, or reach out to your developer.';
    } else {
      const summaries = doneIds.map((id) => {
        const verdict = byId.get(id) as Extract<Verdict, { status: 'done' }>;
        return `- ${verdict.summary} (job #${id})`;
      });
      const title =
        doneIds.length === 1
          ? `AI edit: ${(byId.get(doneIds[0]) as Extract<Verdict, { status: 'done' }>).summary} (job #${doneIds[0]})`
          : `AI edits: ${doneIds.length} changes (jobs ${doneIds.map((id) => `#${id}`).join(', ')})`;
      const message =
        doneIds.length === 1 ? title : `${title}\n\n${summaries.join('\n')}`;
      sha = await commitAndPush({ dir, branch: lead.branch, message });
    }
  } else if (downgradeError) {
    await discardChanges(dir);
  }

  for (const row of jobs) {
    const verdict = byId.get(row.id)!;
    const leadLogs = row.id === lead.id;
    const baseFields = {
      logs: leadLogs ? run.logs : `processed in batch with job #${lead.id}`,
      ...(leadLogs ? run.usage : {}),
    };

    if (verdict.status === 'rejected') {
      await finishJob(row.id, {
        status: 'rejected',
        error: verdict.reason,
        ...baseFields,
      });
    } else if (verdict.status === 'failed') {
      // Claude could not locate the target and (per the guardrail) made no
      // edits rather than guessing. Record the failure; never a commit.
      await finishJob(row.id, {
        status: 'failed',
        error: verdict.error,
        ...baseFields,
      });
    } else if (downgradeError || !sha) {
      await finishJob(row.id, {
        status: forbidden.length ? 'rejected' : 'failed',
        error: downgradeError ?? 'The change could not be saved. Please try again.',
        ...baseFields,
      });
    } else {
      await finishJob(row.id, {
        status: 'done',
        resultSummary: verdict.summary,
        commitSha: sha,
        error: null,
        ...baseFields,
      });
    }
  }

  log(
    `batch #${lead.id}: ${doneIds.length && sha ? `done — ${sha.slice(0, 7)}` : 'no commit'} (${verdicts.filter((v) => v.status === 'rejected').length} rejected)`
  );
};

const tick = async () => {
  const jobs = await claimBatch();
  if (!jobs.length) {
    return false;
  }
  try {
    await processBatch(jobs);
  } catch (error) {
    const message = sanitize((error as Error).message || 'Unknown error');
    log(`batch #${jobs[0].id}: crashed — ${message}`);
    try {
      await discardChanges(`${config.workspaceDir}/${jobs[0].repoId}`);
    } catch {
      // clone may not exist; nothing to discard
    }
    // Per-row (not one bulk update) so each crashed job fires its webhook.
    for (const row of jobs) {
      await finishJob(row.id, {
        status: 'failed',
        error: `The edit could not be completed: ${message.slice(0, 500)}`,
      });
    }
  }
  return true;
};

// Interruptible sleep: a NOTIFY on cp_run_now (from the dashboard's "run now" /
// "retry" buttons) wakes the worker immediately instead of waiting the full poll.
let wake: (() => void) | null = null;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

const main = async () => {
  ensureWorkspace();

  await execFileAsync('git', ['--version']);
  await execFileAsync(config.claudeBin, ['--version']).catch(() => {
    throw new Error(
      `Claude Code CLI not found ("${config.claudeBin}"). Install it and run "claude login".`
    );
  });

  const recovered = await recoverStaleJobs();
  if (recovered.length) {
    log(`recovered ${recovered.length} stale running job(s)`);
    for (const id of recovered) {
      const [full] = await db.select().from(job).where(eq(job.id, id));
      if (full) {
        await dispatchJobWebhooks(full);
      }
    }
  }

  // Wake immediately when the dashboard triggers a run-now / retry.
  await client.listen('cp_run_now', () => {
    if (wake) wake();
  });

  log(
    `worker started — model ${config.claudeModel}, polling every ${config.pollIntervalMs / 1000}s, batch limit ${config.batchLimit}, workspace ${config.workspaceDir}`
  );

  while (true) {
    let worked = false;
    try {
      worked = await tick();
    } catch (error) {
      log(`tick failed: ${sanitize((error as Error).message)}`);
    }
    if (!worked) {
      await sleep(config.pollIntervalMs);
    }
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
