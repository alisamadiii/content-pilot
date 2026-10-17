import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { previewSession } from '@/db/schema';
import { verifyApiKey } from './api-key';
import { verifyEditToken, type EditTokenPayload } from './edit-token';
import {
  extractCredentials,
  SESSION_ENDED_MESSAGE,
  sessionCorsHeaders,
  TERMINAL_SESSION_STATUSES,
} from './request-credentials';

export {
  newSessionId,
  SESSION_ENDED_MESSAGE,
  sessionCorsHeaders,
  TERMINAL_SESSION_STATUSES,
} from './request-credentials';

/**
 * Shared auth for the /api/v1/sessions* routes. Two accepted credentials,
 * mirroring the intake route:
 *  - the long-lived API key (hub server → content-pilot), via `x-api-key`
 *    header or `Authorization: Bearer`;
 *  - the short-lived repo-scoped edit token (browser → content-pilot), via
 *    Bearer or — for EventSource, which cannot set headers — `?token=`.
 * Callers must additionally check `edit.repoId` against the session's repo.
 */
export type SessionAuth =
  | { kind: 'api-key' }
  | { kind: 'edit-token'; payload: EditTokenPayload };

export const authenticateSessionRequest = async (
  request: Request
): Promise<SessionAuth | null> => {
  const { apiKeyCandidate, editTokenCandidate } = extractCredentials(request);

  const key = await verifyApiKey(apiKeyCandidate);
  if (key) return { kind: 'api-key' };

  const edit = verifyEditToken(editTokenCandidate);
  if (edit) return { kind: 'edit-token', payload: edit };

  return null;
};

type SessionRow = typeof previewSession.$inferSelect;

/**
 * The auth + lookup preamble shared by every per-session write route:
 * credential check, session row, repo-scope check for edit tokens, and (unless
 * `allowTerminal`) a 409 for sessions that have ended. Returns either the row
 * or a ready-to-return error Response carrying the CORS headers.
 */
export const loadSessionForEdit = async (
  request: Request,
  id: string,
  options: { allowTerminal?: boolean } = {}
): Promise<
  | { session: SessionRow; auth: SessionAuth; headers: Record<string, string> }
  | { response: Response }
> => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return {
      response: Response.json({ error: 'Unauthorized' }, { status: 401, headers }),
    };
  }
  const [session] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!session) {
    return {
      response: Response.json({ error: 'Not found' }, { status: 404, headers }),
    };
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== session.repoId) {
    return {
      response: Response.json({ error: 'Forbidden' }, { status: 403, headers }),
    };
  }
  if (
    !options.allowTerminal &&
    (TERMINAL_SESSION_STATUSES as readonly string[]).includes(session.status)
  ) {
    return {
      response: Response.json(
        { error: SESSION_ENDED_MESSAGE },
        { status: 409, headers }
      ),
    };
  }
  return { session, auth, headers };
};
