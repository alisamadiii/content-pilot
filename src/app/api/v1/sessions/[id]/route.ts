import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { client, db } from '@/db';
import { previewAttachment, previewMessage, previewSession } from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { removeSessionUploads } from '@/lib/uploads';
import { previewConfig, previewUrlFor } from '@/preview/config';
import { enqueueLiveBuild } from '@/preview/live-build';
import { hasLiveSite } from '@/preview/live-serve';
import {
  baseRef,
  git,
  repoDir,
  squashIntoDefault,
  syncRepo,
} from '@/worker/git';

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('close'),
    reason: z.enum(['discard', 'published']).optional(),
  }),
  // Discard: reset the preview branch to production main, keep the session live.
  z.object({ action: z.literal('reset') }),
  // Pause: abort the in-flight AI run, keep the session live.
  z.object({ action: z.literal('cancel') }),
  // Publish: squash the session branch into the default branch as one commit
  // authored by the project owner, push (GitHub projects), and queue the live
  // build. The hub closes the session after.
  // liveBuild: false = the site is hosted elsewhere (Netlify, Vercel,
  // Cloudflare): squash + push only, no content-pilot build.
  z.object({
    action: z.literal('publish'),
    liveBuild: z.boolean().optional(),
  }),
]);

const loadAuthorized = async (request: Request, id: string) => {
  const auth = await authenticateSessionRequest(request);
  if (!auth) return { error: 401 as const };
  const [row] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) return { error: 404 as const };
  if (auth.kind === 'edit-token' && auth.payload.repoId !== row.repoId) {
    return { error: 403 as const };
  }
  return { row };
};

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const result = await loadAuthorized(request, id);
  if ('error' in result) {
    return Response.json({ error: 'Not available' }, { status: result.error, headers });
  }
  const row = result.row;
  // Read-only on purpose: polling the transcript is NOT activity. Idle expiry
  // is driven only by user messages, so we return lastActivityAt + idleMinutes
  // and let the client compute the countdown / show the idle warning.
  const messages = await db
    .select({
      id: previewMessage.id,
      role: previewMessage.role,
      content: previewMessage.content,
      status: previewMessage.status,
      commitSha: previewMessage.commitSha,
      error: previewMessage.error,
      createdAt: previewMessage.createdAt,
      inputTokens: previewMessage.inputTokens,
      outputTokens: previewMessage.outputTokens,
      cacheReadTokens: previewMessage.cacheReadTokens,
    })
    .from(previewMessage)
    .where(eq(previewMessage.sessionId, id))
    .orderBy(asc(previewMessage.id))
    .limit(200);
  // Images attached to user messages, for the transcript thumbnails. The hub
  // fetches the bytes from /uploads/<id>; description stays server-side.
  const attachmentRows = await db
    .select({
      id: previewAttachment.id,
      messageId: previewAttachment.messageId,
      originalName: previewAttachment.originalName,
      width: previewAttachment.width,
      height: previewAttachment.height,
    })
    .from(previewAttachment)
    .where(
      and(eq(previewAttachment.sessionId, id), isNotNull(previewAttachment.messageId))
    )
    .orderBy(asc(previewAttachment.createdAt));
  const attachmentsByMessage = new Map<number, Array<Omit<(typeof attachmentRows)[number], 'messageId'>>>();
  for (const { messageId, ...attachment } of attachmentRows) {
    if (messageId === null) continue;
    const list = attachmentsByMessage.get(messageId) ?? [];
    list.push(attachment);
    attachmentsByMessage.set(messageId, list);
  }
  return Response.json(
    {
      id: row.id,
      repoId: row.repoId,
      status: row.status,
      branch: row.branch,
      previewUrl: previewUrlFor(row.id),
      error: row.error,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      idleMinutes: previewConfig.idleMinutes,
      messages: messages.map((message) => ({
        ...message,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      })),
    },
    { status: 200, headers }
  );
};

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const result = await loadAuthorized(request, id);
  if ('error' in result) {
    return Response.json({ error: 'Not available' }, { status: result.error, headers });
  }
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400, headers });
  }

  if (parsed.data.action === 'publish') {
    const row = result.row;
    // Never squash mid-edit — the working tree belongs to the in-flight run.
    const [inFlight] = await db
      .select({ id: previewMessage.id })
      .from(previewMessage)
      .where(
        and(
          eq(previewMessage.sessionId, id),
          inArray(previewMessage.status, ['queued', 'running'])
        )
      )
      .limit(1);
    if (inFlight) {
      return Response.json(
        { error: 'The AI is still working on a request. Wait for it to finish, then publish.' },
        { status: 409, headers }
      );
    }
    try {
      let dir: string;
      if (row.source === 'upload') {
        // Upload workspaces have no remote and can never be re-cloned — the
        // local clone IS the project. A missing dir is a hard error.
        dir = repoDir(row.repoId);
        if (!existsSync(join(dir, '.git'))) {
          return Response.json(
            {
              error:
                "This uploaded project's files are missing from the preview server. Re-import the project to continue.",
            },
            { status: 422, headers }
          );
        }
      } else {
        // syncRepo re-clones if the workspace was cleaned and resets the branch
        // to its pushed state (every applied edit is already committed+pushed).
        dir = await syncRepo({
          repoId: row.repoId,
          owner: row.owner,
          repo: row.repo,
          branch: row.branch,
        });
      }
      const squash = await squashIntoDefault({
        dir,
        branch: row.branch,
        message: `Publish site edits (session ${row.id})`,
        author:
          row.commitAuthorName && row.commitAuthorEmail
            ? { name: row.commitAuthorName, email: row.commitAuthorEmail }
            : null,
      });
      if (squash.conflict) {
        return Response.json(
          { error: 'merge_conflict' },
          { status: 409, headers }
        );
      }
      // Content Pilot hosted: the live site is a build of the published commit
      // (GitHub projects were pushed above, inside squashIntoDefault). A no-op
      // publish still builds when the site never went live — e.g. a GitHub
      // project's first publish without edits. Externally hosted projects
      // (liveBuild: false) stop at the push; their host deploys.
      const liveBuild = parsed.data.liveBuild !== false;
      const buildSha = !liveBuild
        ? null
        : squash.changed && squash.sha
          ? squash.sha
          : !hasLiveSite(row.repoId)
            ? await git(dir, ['rev-parse', await baseRef(dir)])
            : null;
      const build = buildSha
        ? await enqueueLiveBuild(row.repoId, buildSha.trim())
        : null;
      return Response.json(
        { id, sha: squash.sha, changed: squash.changed, build },
        { status: 200, headers }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'publish failed';
      return Response.json({ error: message }, { status: 500, headers });
    }
  }

  // The API only writes intent; the supervisor acts on its next reconcile pass.
  if (parsed.data.action === 'reset') {
    // Keep the session live (status unchanged) + reset the idle clock; the
    // supervisor resets the branch to production and clears context/transcript.
    await db
      .update(previewSession)
      .set({
        resetRequestedAt: new Date(),
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(previewSession.id, id));
    try {
      await client.notify('cp_preview', '');
    } catch {
      // supervisor also polls
    }
    return Response.json({ id, reset: true }, { status: 200, headers });
  }

  if (parsed.data.action === 'cancel') {
    // Signal the supervisor to abort the in-flight run; it clears the flag.
    await db
      .update(previewSession)
      .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(previewSession.id, id));
    try {
      await client.notify('cp_preview', '');
    } catch {
      // supervisor also polls
    }
    return Response.json({ id, canceled: true }, { status: 200, headers });
  }

  const status = parsed.data.reason === 'published' ? 'published' : 'closed';
  await db
    .update(previewSession)
    .set({ status, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(previewSession.id, id));
  // Uploaded images die with the chat. The supervisor's teardown also does
  // this, but only for sessions it still has live — a paused session closed
  // from the hub never reaches it, so the route cleans up as well (idempotent;
  // the staging dir is on the shared workspace volume).
  await db.delete(previewAttachment).where(eq(previewAttachment.sessionId, id));
  await removeSessionUploads(id);
  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }
  return Response.json({ id, status }, { status: 200, headers });
};
