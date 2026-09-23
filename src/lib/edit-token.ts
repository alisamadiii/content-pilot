import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies the short-lived, repo-scoped edit-session token minted by the hub
 * (packages/trpc/src/lib/cms/edit-token.ts). The canvas editor puts it in the
 * iframe URL and the cms-bridge overlay sends it here as a Bearer, so the
 * long-lived content-pilot API key never reaches the browser.
 *
 * Format (must match the hub): `base64url(payload).base64url(hmacSHA256(body))`,
 * payload = { repoId, owner, repo, exp }. Signed with the shared
 * EDIT_TOKEN_SECRET. Returns the payload when valid + unexpired, else null.
 */
export interface EditTokenPayload {
  repoId: number;
  owner: string;
  repo: string;
  exp: number;
}

export const verifyEditToken = (
  value: string | null
): EditTokenPayload | null => {
  const secret = process.env.EDIT_TOKEN_SECRET;
  if (!secret || !value) return null;

  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload: EditTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload?.repoId !== 'number' ||
    typeof payload?.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return payload;
};
