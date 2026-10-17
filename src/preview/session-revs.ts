import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { previewMessage } from '@/db/schema';
import { defaultBranch, git } from '../worker/git';

/**
 * The commits a session may be diffed against: every turn's commit sha, the
 * branch head, and the merge-base with production. Anything else is rejected
 * so an edit token can never read arbitrary history out of the clone.
 */
export type SessionRevs = {
  head: string;
  base: string;
  commits: Set<string>;
};

export const loadSessionRevs = async (
  sessionId: string,
  dir: string
): Promise<SessionRevs> => {
  const rows = await db
    .select({ sha: previewMessage.commitSha })
    .from(previewMessage)
    .where(
      and(eq(previewMessage.sessionId, sessionId), isNotNull(previewMessage.commitSha))
    );
  const commits = new Set<string>();
  for (const row of rows) if (row.sha) commits.add(row.sha);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  const branch = await defaultBranch(dir);
  const base = await git(dir, ['merge-base', `origin/${branch}`, 'HEAD']).catch(
    () => head
  );
  return { head, base, commits };
};

/** A rev the route may pass to git: an allowed sha, or `<sha>~1` of one. */
export const resolveAllowedRev = (
  revs: SessionRevs,
  value: string | null
): string | null => {
  if (!value) return null;
  const parent = value.endsWith('~1');
  const sha = parent ? value.slice(0, -2) : value;
  if (sha !== revs.head && sha !== revs.base && !revs.commits.has(sha)) return null;
  return value;
};
