import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/db';
import { apiKey } from '@/db/schema';

export const generateApiKey = () => {
  return `cp_${randomBytes(24).toString('hex')}`;
};

export const hashApiKey = (key: string) => {
  return createHash('sha256').update(key).digest('hex');
};

/**
 * Verifies the x-api-key header against non-revoked keys.
 * Returns the matching key row or null.
 */
export const verifyApiKey = async (headerValue: string | null) => {
  if (!headerValue || !headerValue.startsWith('cp_')) {
    return null;
  }
  const hash = hashApiKey(headerValue);
  const [row] = await db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.keyHash, hash), isNull(apiKey.revokedAt)))
    .limit(1);
  if (!row) {
    return null;
  }
  // Constant-time comparison of the stored hash against the recomputed hash.
  const a = Buffer.from(row.keyHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  void db
    .update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id))
    .then(
      () => {},
      () => {}
    );
  return row;
};
