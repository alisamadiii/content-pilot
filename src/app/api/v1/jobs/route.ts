import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { job, repo } from '@/db/schema';
import { verifyApiKey } from '@/lib/api-key';

const MAX_QUEUED_PER_REPO = 5;

const createJobSchema = z.object({
  repoId: z.number().int().positive(),
  owner: z.string().trim().min(1).max(200),
  repo: z.string().trim().min(1).max(200),
  branch: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(10).max(4000),
  requesterId: z.string().trim().max(200).optional(),
  requestedBy: z.string().trim().max(200).optional(),
  fieldPath: z.string().trim().max(500).optional(),
  pageUrl: z.string().trim().max(1000).optional(),
  elementSelector: z.string().trim().max(1000).optional(),
});

const jobListColumns = {
  id: job.id,
  repoId: job.repoId,
  owner: job.owner,
  repo: job.repo,
  branch: job.branch,
  prompt: job.prompt,
  requesterId: job.requesterId,
  requestedBy: job.requestedBy,
  status: job.status,
  error: job.error,
  resultSummary: job.resultSummary,
  commitSha: job.commitSha,
  batchId: job.batchId,
  model: job.model,
  inputTokens: job.inputTokens,
  outputTokens: job.outputTokens,
  costUsd: job.costUsd,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  createdAt: job.createdAt,
};

export const POST = async (request: Request) => {
  const key = await verifyApiKey(request.headers.get('x-api-key'));
  if (!key) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = createJobSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const [queued] = await db
    .select({ value: count() })
    .from(job)
    .where(
      and(
        eq(job.repoId, input.repoId),
        inArray(job.status, ['queued', 'running'])
      )
    );
  if (queued.value >= MAX_QUEUED_PER_REPO) {
    return Response.json(
      { error: 'Too many pending edits for this site. Please wait for the current ones to finish.' },
      { status: 429 }
    );
  }

  const branch = input.branch || 'main';

  await db
    .insert(repo)
    .values({
      repoId: input.repoId,
      owner: input.owner,
      repo: input.repo,
      branch,
    })
    .onConflictDoUpdate({
      target: repo.repoId,
      set: {
        owner: input.owner,
        repo: input.repo,
        branch,
        updatedAt: new Date(),
      },
    });

  const [created] = await db
    .insert(job)
    .values({
      repoId: input.repoId,
      owner: input.owner,
      repo: input.repo,
      branch,
      prompt: input.prompt,
      requesterId: input.requesterId,
      requestedBy: input.requestedBy,
      fieldPath: input.fieldPath,
      pageUrl: input.pageUrl,
      elementSelector: input.elementSelector,
    })
    .returning({ id: job.id, status: job.status });

  return Response.json(created, { status: 201 });
};

export const GET = async (request: Request) => {
  const key = await verifyApiKey(request.headers.get('x-api-key'));
  if (!key) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const repoIdParam = url.searchParams.get('repoId');
  const requesterId = url.searchParams.get('requesterId');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 50);

  const conditions = [];
  if (repoIdParam) {
    const repoId = Number(repoIdParam);
    if (!Number.isInteger(repoId)) {
      return Response.json({ error: 'Invalid repoId' }, { status: 400 });
    }
    conditions.push(eq(job.repoId, repoId));
  }
  if (requesterId) {
    conditions.push(eq(job.requesterId, requesterId));
  }

  const rows = await db
    .select(jobListColumns)
    .from(job)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(job.createdAt))
    .limit(limit);

  return Response.json({ jobs: rows });
};
