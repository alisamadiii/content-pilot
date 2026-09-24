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
import { runClaude, type ClaudeRun } from './runner';
import { dispatchJobWebhooks } from './webhooks';

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
  const forbidden = findForbiddenPaths(changed);

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
