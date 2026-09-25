import { randomBytes } from 'crypto';
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
