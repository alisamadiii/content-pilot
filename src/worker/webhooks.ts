import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/db';
import {
  job,
  webhook,
  webhookDelivery,
  WEBHOOK_EVENT_VALUES,
  type WebhookEvent,
} from '@/db/schema';
import { signWebhookBody } from '@/lib/webhook';

type Job = typeof job.$inferSelect;

const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2_000;

const isWebhookEvent = (status: string): status is WebhookEvent =>
  (WEBHOOK_EVENT_VALUES as readonly string[]).includes(status);

const parseEvents = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

/**
 * Fires every matching webhook for a job that just reached a terminal state.
 * Best-effort: each send is isolated in try/catch and every attempt is logged to
 * `webhook_delivery`, so a slow or broken receiver never crashes the worker loop.
 */
export const dispatchJobWebhooks = async (row: Job) => {
  if (!isWebhookEvent(row.status)) {
    return;
  }

  let hooks: (typeof webhook.$inferSelect)[];
  try {
    hooks = await db
      .select()
      .from(webhook)
      .where(
        and(
          eq(webhook.enabled, true),
          or(isNull(webhook.repoId), eq(webhook.repoId, row.repoId))
        )
      );
  } catch (error) {
    console.error(
      `[webhooks] failed to load webhooks for job #${row.id}: ${
        (error as Error).message
      }`
    );
    return;
  }

  const targets = hooks.filter((hook) =>
    parseEvents(hook.events).includes(row.status)
  );
  if (!targets.length) {
    return;
  }

  const body = JSON.stringify({
    jobId: row.id,
    repoId: row.repoId,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    prompt: row.prompt,
    status: row.status,
    error: row.error,
    resultSummary: row.resultSummary,
    commitSha: row.commitSha,
    requestedBy: row.requestedBy,
    finishedAt: row.finishedAt,
  });

  for (const hook of targets) {
    const startedAt = Date.now();
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-content-pilot-signature': signWebhookBody(body, hook.secret),
          'x-content-pilot-event': row.status,
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      const responseBody = (await res.text().catch(() => '')).slice(
        0,
        MAX_RESPONSE_BYTES
      );
      await db.insert(webhookDelivery).values({
        webhookId: hook.id,
        jobId: row.id,
        repoId: row.repoId,
        event: row.status,
        url: hook.url,
        requestBody: body,
        responseStatus: res.status,
        responseBody,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      await db
        .insert(webhookDelivery)
        .values({
          webhookId: hook.id,
          jobId: row.id,
          repoId: row.repoId,
          event: row.status,
          url: hook.url,
          requestBody: body,
          error: (error as Error).message.slice(0, 500),
          durationMs: Date.now() - startedAt,
        })
        .catch(() => {});
    }
  }
};
