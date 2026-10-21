import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { previewSession } from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';
import { listSkills } from '@/preview/skills';
import { repoDir } from '@/worker/git';

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

/**
 * Lists the skills available in the session repo's workspace clone (root
 * `.claude/skills/`) — powers the hub chat's "/" menu. The clone persists across
 * paused sessions; an empty list just means it hasn't been cloned yet.
 */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  const [row] = await db
    .select({ id: previewSession.id, repoId: previewSession.repoId })
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) {
    return Response.json({ error: 'Not found' }, { status: 404, headers });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== row.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers });
  }

  const skills = await listSkills(repoDir(row.repoId));
  return Response.json(
    { skills },
    { status: 200, headers }
  );
};
