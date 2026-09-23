'use server';

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { apiKey } from '@/db/schema';
import { generateApiKey, hashApiKey } from '@/lib/api-key';
import { auth } from '@/lib/auth';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

export const createApiKeyAction = async (formData: FormData) => {
  await requireSession();
  const name = String(formData.get('name') || '').trim() || 'unnamed';
  const plaintext = generateApiKey();
  await db.insert(apiKey).values({ name, keyHash: hashApiKey(plaintext) });
  revalidatePath('/settings');
  // Returned once; never stored in plaintext.
  return { plaintext, name };
};

export const revokeApiKeyAction = async (formData: FormData) => {
  await requireSession();
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) {
    await db
      .update(apiKey)
      .set({ revokedAt: new Date() })
      .where(eq(apiKey.id, id));
  }
  revalidatePath('/settings');
};

// Permanently removes the key row (unlike revoke, which only disables it).
export const deleteApiKeyAction = async (formData: FormData) => {
  await requireSession();
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) {
    await db.delete(apiKey).where(eq(apiKey.id, id));
  }
  revalidatePath('/settings');
};
