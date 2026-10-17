import { loadSessionForEdit, sessionCorsHeaders } from '@/lib/session-auth';
import { IMAGE_PATH, isFullSha, resolveRepoPath, showFileAt } from '@/preview/file-diff';
import { loadSessionRevs, resolveAllowedRev } from '@/preview/session-revs';
import { repoDir } from '@/worker/git';

/**
 * Before/after of one file between two commits of this session's branch:
 *   GET ?to=<sha>&path=<file>            → parent of `to` vs `to` (one turn)
 *   GET ?from=<sha>&to=<sha>&path=<file> → e.g. merge-base vs head (whole session)
 * Shas must be the session's own turn commits, its head, or the merge-base.
 * The hub draws the diff client-side (lib/line-diff), so this returns both
 * texts rather than a unified patch.
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

  const url = new URL(request.url);
  const to = url.searchParams.get('to') ?? '';
  const fromParam = url.searchParams.get('from');
  const pathParam = url.searchParams.get('path') ?? '';
  if (!isFullSha(to) || (fromParam !== null && !isFullSha(fromParam))) {
    return Response.json({ error: 'Invalid commit' }, { status: 400, headers });
  }
  const dir = repoDir(session.repoId);
  const path = resolveRepoPath(dir, pathParam);
  if (!path) {
    return Response.json({ error: 'Invalid path' }, { status: 400, headers });
  }
  if (IMAGE_PATH.test(path)) {
    return Response.json({ error: 'Binary file' }, { status: 415, headers });
  }

  const revs = await loadSessionRevs(session.id, dir);
  const toRev = resolveAllowedRev(revs, to);
  const fromRev = resolveAllowedRev(revs, fromParam ?? `${to}~1`);
  if (!toRev || !fromRev) {
    return Response.json({ error: 'Unknown commit' }, { status: 404, headers });
  }

  const [before, after] = await Promise.all([
    showFileAt(dir, fromRev, path),
    showFileAt(dir, toRev, path),
  ]);
  return Response.json(
    {
      path,
      before: before?.text ?? null,
      after: after?.text ?? null,
      truncated: Boolean(before?.truncated || after?.truncated),
    },
    { status: 200, headers: { ...headers, 'cache-control': 'private, max-age=3600' } }
  );
};
