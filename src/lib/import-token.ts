import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies the one-time project-import token minted by the hub
 * (packages/trpc/src/lib/cms/edit-token.ts signImportToken). Same HMAC scheme
 * and shared EDIT_TOKEN_SECRET as the edit token, but the payload carries
 * `scope: 'import'` so the two can never stand in for each other:
 * verifyEditToken rejects any payload with a `scope` field, and this verifier
 * requires it. The token authorizes exactly one zip upload for one repoId —
 * the import route 409s once the workspace dir exists.
 */
export interface ImportTokenPayload {
  repoId: number;
  scope: 'import';
  exp: number;
}

export const verifyImportToken = (
  value: string | null
): ImportTokenPayload | null => {
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

  let payload: ImportTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload?.repoId !== 'number' ||
    payload?.scope !== 'import' ||
    typeof payload?.exp !== 'number' ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }

  return payload;
};
