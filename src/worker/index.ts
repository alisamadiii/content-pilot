import { execFile } from 'child_process';
import { eq, inArray } from 'drizzle-orm';
import { promisify } from 'util';
import { db } from '@/db';
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
  findForbiddenPaths,
  parseVerdicts,
  type Verdict,
} from './guardrails';
import { runClaude, type ClaudeRun } from './runner';

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
    await db
      .update(job)
      .set({
        status: 'failed',
        error: `The edit could not be completed: ${message.slice(0, 500)}`,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        inArray(
          job.id,
          jobs.map((row) => row.id)
        )
      );
  }
  return true;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
  ensureWorkspace();

  await execFileAsync('git', ['--version']);
  await execFileAsync(config.claudeBin, ['--version']).catch(() => {
    throw new Error(
      `Claude Code CLI not found ("${config.claudeBin}"). Install it and run "claude login".`
    );
  });

  const recovered = await recoverStaleJobs();
  if (recovered) {
    log(`recovered ${recovered} stale running job(s)`);
  }

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
