import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { client, db } from '@/db';
import { previewAttachment, previewSession } from '@/db/schema';
import { removeSessionUploads } from '@/lib/uploads';

/**
 * Stop every live editing session of a project before its source is swapped
 * (zip replace, pull from the GitHub backup). Sessions still booting own the
 * clone (npm install, checkout), so replacing the tree under them would race:
 * the caller gets `booting: true` and answers 409. Ready/paused sessions are
 * killed by pid (the supervisor and this app share the pid namespace), their
 * staged uploads removed and the rows closed with `reason` as the error.
 */

const BOOTING = new Set<string>(['starting', 'installing', 'restarting']);
const TERMINAL = ['failed', 'closed', 'published', 'expired'] as const;

export const closeProjectSessions = async (
  projectId: string,
  reason: string
): Promise<{ booting: true } | { booting: false; closed: number }> => {
  const sessions = await db
    .select({ id: previewSession.id, pid: previewSession.pid, status: previewSession.status })
    .from(previewSession)
    .where(
      and(
        eq(previewSession.projectId, projectId),
        notInArray(previewSession.status, [...TERMINAL])
      )
    );
  if (sessions.some((s) => BOOTING.has(s.status))) {
    return { booting: true };
  }
  // Their branches are cut from the old source and get deleted with it. The
  // supervisor tears down its side on the next tick; killing the pid here
  // frees the tree right away.
  for (const session of sessions) {
    if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await removeSessionUploads(session.id);
  }
  if (sessions.length) {
    const ids = sessions.map((s) => s.id);
    await db
      .update(previewSession)
      .set({
        status: 'closed',
        error: reason,
        closedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(previewSession.id, ids));
    await db
      .delete(previewAttachment)
      .where(inArray(previewAttachment.sessionId, ids));
    try {
      await client.notify('cp_preview', '');
    } catch {
      // The supervisor also polls.
    }
  }
  return { booting: false, closed: sessions.length };
};
