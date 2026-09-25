import { sql } from 'drizzle-orm';
import { db } from '@/db';
import { job } from '@/db/schema';
import { config } from './config';

type Job = typeof job.$inferSelect;

/**
 * Atomically claims ALL queued jobs (up to BATCH_LIMIT, oldest first) for the
 * oldest-waiting repo that has no running job. They are solved together in
 * one Claude session. SKIP LOCKED makes this safe with multiple workers.
 * Returns jobs ordered by id; the first is the batch lead.
 */
export const claimBatch = async (): Promise<Job[]> => {
  return db.transaction(async (tx) => {
    const target = await tx.execute(sql`
      SELECT repo_id AS "repoId", unrestricted FROM job
      WHERE status = 'queued'
        AND repo_id NOT IN (SELECT repo_id FROM job WHERE status = 'running')
        -- A live preview session owns the repo clone (its dev server serves
        -- that working tree); batches for the repo wait until it ends.
        AND repo_id NOT IN (
          SELECT repo_id FROM preview_session
          WHERE status IN ('starting','installing','ready','restarting')
        )
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const lead = target[0] as
      | { repoId: number; unrestricted: boolean }
      | undefined;
    if (!lead) {
      return [];
    }

    // The whole batch shares one Claude session and one system prompt, so a
    // batch must be all-guardrailed or all-unrestricted — never mixed. Jobs
    // with the other flag stay queued for a later batch.
    const rows = await tx.execute(sql`
      UPDATE job SET status = 'running', started_at = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM job
        WHERE repo_id = ${lead.repoId} AND status = 'queued'
          AND unrestricted = ${lead.unrestricted}
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${config.batchLimit}
      )
      RETURNING
        id, repo_id AS "repoId", owner, repo, branch, prompt,
        requester_id AS "requesterId", requested_by AS "requestedBy",
        field_path AS "fieldPath", page_url AS "pageUrl",
        element_selector AS "elementSelector",
        source_ref AS "sourceRef", element_text AS "elementText",
        status, unrestricted, error, result_summary AS "resultSummary",
        commit_sha AS "commitSha", logs, batch_id AS "batchId",
        input_tokens AS "inputTokens", output_tokens AS "outputTokens",
        cost_usd AS "costUsd",
        started_at AS "startedAt", finished_at AS "finishedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
    `);

    const jobs = (rows as unknown as Job[]).sort((a, b) => a.id - b.id);
    if (jobs.length) {
      const leadId = jobs[0].id;
      await tx.execute(sql`
        UPDATE job SET batch_id = ${leadId}
        WHERE id IN ${sql.raw(`(${jobs.map((row) => row.id).join(',')})`)}
      `);
      for (const row of jobs) {
        row.batchId = leadId;
      }
    }
    return jobs;
  });
};

/**
 * Fails jobs stuck in 'running' from a previous crashed worker.
 * Returns the recovered job ids so the caller can fire their webhooks.
 */
export const recoverStaleJobs = async (): Promise<number[]> => {
  const rows = await db.execute(sql`
    UPDATE job
    SET status = 'failed',
        error = 'The edit service restarted while working on this request. Please resubmit.',
        finished_at = now(), updated_at = now()
    WHERE status = 'running'
      AND started_at < now() - make_interval(mins => ${config.staleRunningMinutes})
    RETURNING id
  `);
  return (rows as unknown as { id: number }[]).map((row) => row.id);
};
