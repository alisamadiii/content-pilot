import { randomBytes } from 'crypto';

// DB-free half of src/lib/session-auth.ts: credential extraction, CORS headers
// and id minting. Unit-tested without a DATABASE_URL.

/**
 * The three places a credential can ride on a /api/v1/sessions* request:
 *  - `x-api-key` header (hub server → content-pilot),
 *  - `Authorization: Bearer …` (either credential),
 *  - `?token=` query (edit token only; EventSource cannot set headers).
 */
export const extractCredentials = (request: Request) => {
  const headerKey = request.headers.get('x-api-key');
  const bearerMatch = (request.headers.get('authorization') || '').match(
    /^Bearer\s+(.+)$/i
  );
  const bearer = bearerMatch ? bearerMatch[1].trim() : null;
  const queryToken = new URL(request.url).searchParams.get('token');
  return {
    /** Candidate for the long-lived API key: header first, else bearer. */
    apiKeyCandidate: headerKey ?? bearer,
    /** Candidate for the edit token: bearer first, else `?token=`. */
    editTokenCandidate: bearer ?? queryToken,
  };
};

/** Session states that no longer accept chat input (messages, uploads). */
export const TERMINAL_SESSION_STATUSES = [
  'failed',
  'closed',
  'published',
  'expired',
] as const;

export const SESSION_ENDED_MESSAGE =
  'This editing session has ended. Please reopen the project to start a new one.';

export const sessionCorsHeaders = (origin: string | null) => ({
  // Token is the security boundary, not the origin — same model as intake.
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

export const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const SESSION_ID_LENGTH = 12;

// Lowercase alphanumeric so the id is a valid DNS label (preview subdomain)
// and branch suffix.
export const newSessionId = () => {
  const bytes = randomBytes(SESSION_ID_LENGTH);
  let id = '';
  for (const byte of bytes) {
    id += SESSION_ID_ALPHABET[byte % SESSION_ID_ALPHABET.length];
  }
  return id;
};
