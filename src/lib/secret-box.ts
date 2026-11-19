import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM for small secrets at rest (project env values). Key = base64 of
// 32 random bytes in ENV_ENCRYPTION_KEY (generate: openssl rand -base64 32).
// Blob format: `v1:<iv>:<tag>:<ciphertext>`, each part base64. The version
// prefix leaves room for a key rotation / algorithm change later.

const VERSION = 'v1';

export const MISSING_KEY_MESSAGE =
  'ENV_ENCRYPTION_KEY is not set on the preview server, so environment variables cannot be stored.';

const loadKey = (raw: string | undefined = process.env.ENV_ENCRYPTION_KEY) => {
  if (!raw?.trim()) throw new Error(MISSING_KEY_MESSAGE);
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error('ENV_ENCRYPTION_KEY must be the base64 of exactly 32 bytes.');
  }
  return key;
};

/** True when ENV_ENCRYPTION_KEY is set (validity is checked on use). */
export const hasSecretKey = () => Boolean(process.env.ENV_ENCRYPTION_KEY?.trim());

export const encryptSecret = (text: string, rawKey?: string): string => {
  const key = loadKey(rawKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64')))
    .join(':');
};

/** Throws on a malformed blob, a wrong key, or any tampering (GCM auth tag). */
export const decryptSecret = (blob: string, rawKey?: string): string => {
  const key = loadKey(rawKey);
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognized encrypted value format.');
  }
  const [, iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
};
