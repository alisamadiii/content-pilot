import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { previewMessage } from '@/db/schema';
import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import { restoreFiles } from '@/preview/restore-files';
import { commitAndPush, repoDir } from '@/worker/git';

/**
 * Manual revert from the hub's Changes dialog: put one file (or folder) back
 * to its live-site version and commit that on the session branch. The AI is
 * never involved — the owner clicks Revert on a file they can see the diff
 * of. Refused while a chat message is queued/running (the agent and the
 * revert would race on the same working tree).
 */
const bodySchema = z.object({
  path: z.string().trim().min(1).max(500),
});

export const OPTIONS = async (request: Request) =>
  new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const loaded = await loadSessionForEdit(request, id);
  if ('response' in loaded) return loaded.response;
  const { session, headers } = loaded;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'A file path is required.' }, { status: 400, headers });
  }

  const [inFlight] = await db
    .select({ id: previewMessage.id })
    .from(previewMessage)
    .where(
      and(
        eq(previewMessage.sessionId, session.id),
        inArray(previewMessage.status, ['queued', 'running'])
      )
    )
    .limit(1);
  if (inFlight) {
    return Response.json(
      { error: 'The AI is still working on a request. Wait for it to finish, then revert.' },
      { status: 409, headers }
    );
  }

  const dir = repoDir(session.repoId);
  const result = await restoreFiles({ dir, paths: [parsed.data.path] });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 400, headers });
  }
  const touched = [...result.restored, ...result.removed];
  if (!touched.length) {
    return Response.json(
      {
        error: result.skipped.length
          ? 'This file is protected and cannot be reverted here.'
          : 'This file already matches your live site.',
      },
      { status: 409, headers }
    );
  }
  const sha = await commitAndPush({
    dir,
    branch: session.branch,
    message: `Reverted ${touched.length === 1 ? touched[0] : `${touched.length} files`} to the live site`,
  });
  return Response.json(
    { commitSha: sha, restored: result.restored, removed: result.removed, skipped: result.skipped },
    { status: 200, headers }
  );
};
