import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { client, db } from "@/db";
import { job, repo } from "@/db/schema";
import { verifyApiKey } from "@/lib/api-key";
import { verifyEditToken } from "@/lib/edit-token";
import { resolveRepo } from "@/lib/resolve-repo";

// Mirrors jobs/route.ts — the same abuse guard applies to the intake.
const MAX_QUEUED_PER_REPO = 5;

// Public intake for the cms-bridge overlay. Auth = a bearer token the hub
// injects into the edit-mode iframe URL (never baked into the site bundle).
// The token is a normal API key created in Settings; the browser sends it as
// `Authorization: Bearer <token>`. Repo identity is the repoId alone — the
// owner/repo slug is resolved server-side (repo table, then GitHub by id).
const intakeSchema = z.object({
  repoId: z.number().int().positive(),
  branch: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().trim().min(4).max(4000),
  sourceRef: z.string().trim().max(500).optional(),
  elementText: z.string().trim().max(2000).optional(),
  pageUrl: z.string().trim().max(1000).optional(),
  // Reference images pasted as CDN links in the overlay's page-level chat.
  // Folded into the stored prompt so the worker + job table stay unchanged.
  imageUrls: z.array(z.string().trim().url().max(1000)).max(10).optional(),
});

const bearer = (request: Request) => {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
};

const corsHeaders = (origin: string | null) => ({
  // Token is the security boundary, not the origin — echo the caller so the
  // browser fetch from the client site is allowed.
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
};

export const POST = async (request: Request) => {
  const headers = corsHeaders(request.headers.get("origin"));

  // Two accepted credentials: a long-lived API key (server-to-server), or a
  // short-lived, repo-scoped edit token minted by the hub for a browser session
  // (so the API key never reaches the client bundle).
  const token = bearer(request);
  const key = await verifyApiKey(token);
  const edit = key ? null : verifyEditToken(token);
  if (!key && !edit) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  const parsed = intakeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400, headers },
    );
  }
  const input = parsed.data;
  const branch = input.branch || "main";

  // An edit token authorizes exactly one repo — never trust the body's repo
  // identity over the token's scope.
  if (edit && edit.repoId !== input.repoId) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }

  const [queued] = await db
    .select({ value: count() })
    .from(job)
    .where(
      and(
        eq(job.repoId, input.repoId),
        inArray(job.status, ["queued", "running"]),
      ),
    );
  if (queued.value >= MAX_QUEUED_PER_REPO) {
    return Response.json(
      {
        error:
          "Too many pending edits for this site. Please wait for the current ones to finish.",
      },
      { status: 429, headers },
    );
  }

  const resolved = await resolveRepo(input.repoId);
  if (!resolved) {
    return Response.json(
      { error: "Unknown repository — could not resolve owner/repo from repoId." },
      { status: 422, headers },
    );
  }

  // Register/refresh the repo (trusted — the request is authenticated).
  await db
    .insert(repo)
    .values({
      repoId: input.repoId,
      owner: resolved.owner,
      repo: resolved.repo,
      branch,
    })
    .onConflictDoUpdate({
      target: repo.repoId,
      set: {
        owner: resolved.owner,
        repo: resolved.repo,
        branch,
        updatedAt: new Date(),
      },
    });

  const [created] = await db
    .insert(job)
    .values({
      repoId: input.repoId,
      owner: resolved.owner,
      repo: resolved.repo,
      branch,
      prompt: input.imageUrls?.length
        ? `${input.prompt}\n\nAttached images (CDN URLs):\n${input.imageUrls
            .map((url) => `- ${url}`)
            .join("\n")}`
        : input.prompt,
      requestedBy: "website visitor",
      sourceRef: input.sourceRef,
      elementText: input.elementText,
      pageUrl: input.pageUrl,
    })
    .returning({ id: job.id, status: job.status });

  try {
    await client.notify("cp_run_now", "");
  } catch {
    // NOTIFY is best-effort; the worker still picks it up on its next poll.
  }

  return Response.json(created, { status: 201, headers });
};
