import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { job } from '@/db/schema';
import { verifyApiKey } from '@/lib/api-key';

type RouteContext = { params: Promise<{ id: string }> };

const parseId = async (context: RouteContext) => {
  const { id } = await context.params;
  const numeric = Number(id);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

export const GET = async (request: Request, context: RouteContext) => {
  const key = await verifyApiKey(request.headers.get('x-api-key'));
  if (!key) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const id = await parseId(context);
  if (!id) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const [row] = await db
    .select({
      id: job.id,
      repoId: job.repoId,
      owner: job.owner,
      repo: job.repo,
      branch: job.branch,
      prompt: job.prompt,
      requesterId: job.requesterId,
      requestedBy: job.requestedBy,
      fieldPath: job.fieldPath,
      pageUrl: job.pageUrl,
      sourceRef: job.sourceRef,
      elementText: job.elementText,
      status: job.status,
      error: job.error,
      resultSummary: job.resultSummary,
      commitSha: job.commitSha,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      createdAt: job.createdAt,
    })
    .from(job)
    .where(eq(job.id, id))
    .limit(1);

  if (!row) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  return Response.json(row);
};

export const DELETE = async (request: Request, context: RouteContext) => {
  const key = await verifyApiKey(request.headers.get('x-api-key'));
  if (!key) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const id = await parseId(context);
  if (!id) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const updated = await db
    .update(job)
    .set({ status: 'canceled', finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(job.id, id), eq(job.status, 'queued')))
    .returning({ id: job.id });

  if (!updated.length) {
    return Response.json(
      { error: 'Job is not queued (already running or finished)' },
      { status: 409 }
    );
  }
  return Response.json({ id, status: 'canceled' });
};
