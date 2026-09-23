'use server';

import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { db } from '@/db';
import { domain, repo } from '@/db/schema';
import { auth } from '@/lib/auth';

const requireSession = async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    throw new Error('Unauthorized');
  }
};

/**
 * Normalize a user-entered domain to a bare origin (scheme://host[:port]),
 * defaulting to https when no scheme is given. Returns null when it is not a
 * valid http(s) origin — a path/query is stripped, not rejected.
 */
const normalizeOrigin = (raw: string): string | null => {
  let value = raw.trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
};

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Register (or update) a site, optionally with its first domain. */
export const registerSiteAction = async (
  formData: FormData
): Promise<ActionResult> => {
  await requireSession();
  const repoId = Number(formData.get('repoId'));
  const owner = String(formData.get('owner') || '').trim();
  const name = String(formData.get('repo') || '').trim();
  const branch = String(formData.get('branch') || '').trim() || 'main';
  const firstDomain = String(formData.get('domain') || '').trim();

  if (!Number.isInteger(repoId) || repoId <= 0) {
    return { ok: false, error: 'Repo id must be a positive integer.' };
  }
  if (!owner || !name) {
    return { ok: false, error: 'Owner and repo are required.' };
  }

  let origin: string | null = null;
  if (firstDomain) {
    origin = normalizeOrigin(firstDomain);
    if (!origin) {
      return { ok: false, error: `Invalid domain: ${firstDomain}` };
    }
    // Reject if the origin is already claimed by a different site.
    const [existing] = await db
      .select({ repoId: domain.repoId })
      .from(domain)
      .where(eq(domain.origin, origin))
      .limit(1);
    if (existing && existing.repoId !== repoId) {
      return {
        ok: false,
        error: `${origin} is already whitelisted for another site.`,
      };
    }
  }

  await db
    .insert(repo)
    .values({ repoId, owner, repo: name, branch })
    .onConflictDoUpdate({
      target: repo.repoId,
      set: { owner, repo: name, branch, updatedAt: new Date() },
    });

  if (origin) {
    await db
      .insert(domain)
      .values({ origin, repoId })
      .onConflictDoNothing({ target: domain.origin });
  }

  revalidatePath('/domains');
  return { ok: true };
};

/** Add a whitelisted origin to a registered site. */
export const addDomainAction = async (
  formData: FormData
): Promise<ActionResult> => {
  await requireSession();
  const repoId = Number(formData.get('repoId'));
  const origin = normalizeOrigin(String(formData.get('domain') || ''));
  if (!Number.isInteger(repoId)) {
    return { ok: false, error: 'Unknown site.' };
  }
  if (!origin) {
    return { ok: false, error: 'Enter a valid domain, e.g. https://acme.com' };
  }

  const [existing] = await db
    .select({ repoId: domain.repoId })
    .from(domain)
    .where(eq(domain.origin, origin))
    .limit(1);
  if (existing) {
    if (existing.repoId === repoId) {
      return { ok: false, error: `${origin} is already added.` };
    }
    return {
      ok: false,
      error: `${origin} is already whitelisted for another site.`,
    };
  }

  await db.insert(domain).values({ origin, repoId });
  revalidatePath('/domains');
  return { ok: true };
};

/** Remove a whitelisted origin from a site. */
export const removeDomainAction = async (
  formData: FormData
): Promise<ActionResult> => {
  await requireSession();
  const repoId = Number(formData.get('repoId'));
  const origin = String(formData.get('domain') || '').trim();
  if (!Number.isInteger(repoId) || !origin) {
    return { ok: false, error: 'Invalid request.' };
  }
  await db
    .delete(domain)
    .where(and(eq(domain.repoId, repoId), eq(domain.origin, origin)));
  revalidatePath('/domains');
  return { ok: true };
};
