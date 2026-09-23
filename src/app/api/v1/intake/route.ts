import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import { domain, job, repo } from '@/db/schema';

// Mirrors jobs/route.ts — the same abuse guard applies to the public intake.
const MAX_QUEUED_PER_REPO = 5;

// Public, token-less intake for the cms-bridge overlay. Security is the
// server-side Origin whitelist on the repo row — never trust client-sent repo
// identity; the origin resolves the target repo.
const intakeSchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  sourceRef: z.string().trim().max(500).optional(),
  elementText: z.string().trim().max(2000).optional(),
  pageUrl: z.string().trim().max(1000).optional(),
});

/** Resolve the repo a whitelisted `origin` maps to (exact, unique match). */
const repoForOrigin = async (origin: string) => {
  const [row] = await db
    .select({
      repoId: repo.repoId,
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
    })
    .from(domain)
    .innerJoin(repo, eq(repo.repoId, domain.repoId))
    .where(eq(domain.origin, origin))
    .limit(1);
  return row ?? null;
};

const corsHeaders = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
});

export const OPTIONS = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (!origin) return new Response(null, { status: 403 });
  const matched = await repoForOrigin(origin);
  if (!matched) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
};

export const POST = async (request: Request) => {
  const origin = request.headers.get('origin');
  if (!origin) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const site = await repoForOrigin(origin);
  if (!site) {
    // Do not leak whether the origin exists — same response for all misses.
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const headers = corsHeaders(origin);

  const parsed = intakeSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400, headers }
    );
  }
  const input = parsed.data;

  const [queued] = await db
    .select({ value: count() })
    .from(job)
    .where(
      and(
        eq(job.repoId, site.repoId),
        inArray(job.status, ['queued', 'running'])
      )
    );
  if (queued.value >= MAX_QUEUED_PER_REPO) {
    return Response.json(
      {
        error:
          'Too many pending edits for this site. Please wait for the current ones to finish.',
      },
      { status: 429, headers }
    );
  }

  const [created] = await db
    .insert(job)
    .values({
      repoId: site.repoId,
      owner: site.owner,
      repo: site.repo,
      branch: site.branch,
      prompt: input.prompt,
      requestedBy: 'website visitor',
      sourceRef: input.sourceRef,
      elementText: input.elementText,
      pageUrl: input.pageUrl,
    })
    .returning({ id: job.id, status: job.status });

  // Wake the worker so the edit doesn't wait for the next poll.
  try {
    await client.notify('cp_run_now', '');
  } catch {
    // NOTIFY is best-effort; the worker still picks it up on its next poll.
  }

  return Response.json(created, { status: 201, headers });
};
