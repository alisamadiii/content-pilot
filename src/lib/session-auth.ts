import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { previewSession } from '@/db/schema';
import { verifyApiKey } from './api-key';
import { verifyEditToken, type EditTokenPayload } from './edit-token';

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
  const headerKey = request.headers.get('x-api-key');
  const bearerMatch = (request.headers.get('authorization') || '').match(
    /^Bearer\s+(.+)$/i
  );
  const bearer = bearerMatch ? bearerMatch[1].trim() : null;
  const queryToken = new URL(request.url).searchParams.get('token');

  const key = await verifyApiKey(headerKey ?? bearer);
  if (key) return { kind: 'api-key' };

  const edit = verifyEditToken(bearer ?? queryToken);
  if (edit) return { kind: 'edit-token', payload: edit };

  return null;
};

/** Session states that no longer accept chat input (messages, uploads). */
export const TERMINAL_SESSION_STATUSES = [
  'needs_config',
  'failed',
  'closed',
  'published',
  'expired',
] as const;

export const SESSION_ENDED_MESSAGE =
  'This editing session has ended. Please reopen the project to start a new one.';

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

export const sessionCorsHeaders = (origin: string | null) => ({
  // Token is the security boundary, not the origin — same model as intake.
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

// Lowercase alphanumeric so the id is a valid DNS label (preview subdomain)
// and branch suffix.
export const newSessionId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let id = '';
  for (const byte of bytes) {
    id += alphabet[byte % alphabet.length];
  }
  return id;
};
