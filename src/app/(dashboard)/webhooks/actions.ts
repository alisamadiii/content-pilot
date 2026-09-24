'use server';

import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { webhook, WEBHOOK_EVENT_VALUES } from '@/db/schema';
import { generateWebhookSecret } from '@/lib/webhook';
import { auth } from '@/lib/auth';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

export const createWebhookAction = async (formData: FormData) => {
  await requireSession();
  const name = String(formData.get('name') || '').trim() || 'unnamed';
  const url = String(formData.get('url') || '').trim();
  if (!/^https?:\/\//.test(url)) {
    throw new Error('A valid http(s) URL is required.');
  }

  const scope = String(formData.get('repoId') || '');
  const repoId = scope ? Number(scope) : null;
  if (scope && !Number.isInteger(repoId)) {
    throw new Error('Invalid repo scope.');
  }

  const events = formData
    .getAll('events')
    .map(String)
    .filter((event) =>
      (WEBHOOK_EVENT_VALUES as readonly string[]).includes(event)
    );
  if (!events.length) {
    throw new Error('Select at least one event.');
  }

  await db.insert(webhook).values({
    name,
    url,
    secret: generateWebhookSecret(),
    repoId,
    events: JSON.stringify(events),
  });
  revalidatePath('/webhooks');
};

export const toggleWebhookAction = async (formData: FormData) => {
  await requireSession();
  const id = Number(formData.get('id'));
  const enabled = String(formData.get('enabled')) === 'true';
  if (Number.isInteger(id)) {
    await db
      .update(webhook)
      .set({ enabled: !enabled, updatedAt: new Date() })
      .where(eq(webhook.id, id));
  }
  revalidatePath('/webhooks');
};

export const deleteWebhookAction = async (formData: FormData) => {
  await requireSession();
  const id = Number(formData.get('id'));
  if (Number.isInteger(id)) {
    await db.delete(webhook).where(eq(webhook.id, id));
  }
  revalidatePath('/webhooks');
};
