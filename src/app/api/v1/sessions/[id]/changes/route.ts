import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import { parseNameStatus } from '@/preview/file-diff';
import { loadSessionRevs } from '@/preview/session-revs';
import { git, repoDir } from '@/worker/git';

/**
 * Every file this session has changed vs production (merge-base → head), for
 * the hub's "Changes" dialog. Git-backed, so it covers every turn and survives
 * reloads; per-file content comes from the sibling diff route with
 * `from=<base>&to=<head>`.
 */
export const OPTIONS = async (request: Request) =>
  new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const loaded = await loadSessionForEdit(request, id);
  if ('response' in loaded) return loaded.response;
  const { session, headers } = loaded;

  const dir = repoDir(session.repoId);
  const revs = await loadSessionRevs(session.id, dir);
  const output =
    revs.base === revs.head
      ? ''
      : await git(dir, ['diff', '--name-status', revs.base, revs.head]);
  return Response.json(
    { head: revs.head, base: revs.base, files: parseNameStatus(output) },
    { status: 200, headers }
  );
};
