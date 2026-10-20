import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { client } from '@/db';
import { verifyApiKey } from '@/lib/api-key';
import {
  normalizeHost,
  previewBaseHost,
  slugHost,
  validateCustomHost,
  validateSlug,
} from '@/lib/domain-rules';
import { extractCredentials } from '@/lib/request-credentials';
import {
  getDomainRepoId,
  listDomainsForRepo,
  removeAllDomainsForRepo,
  removeDomainMapping,
  setDomainMapping,
} from '@/lib/settings';
import { repoDir } from '@/worker/git';
import { previewConfig } from '@/preview/config';
import { isLiveServable } from '@/preview/live-serve';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only) domain management for uploaded projects.
 * The hub orchestrates; this route owns the serving map (`domain:<host>`
 * settings rows) the preview proxy resolves hosts against.
 *
 *  - PUT { slug } : set/replace the project's free subdomain (slug under the
 *    preview wildcard, e.g. acme.alisamadii.dev).
 *  - PUT { host } : set/replace the project's custom domain mapping (called by
 *    the hub only AFTER Cloudflare verified the hostname).
 *  - DELETE ?host= : remove one mapping; no host = remove all for the repo.
 *
 * Every write NOTIFYs cp_domains so the supervisor's in-memory map refreshes.
 */

const putSchema = z.union([
  z.object({ slug: z.string().trim().min(1).max(100) }),
  z.object({ host: z.string().trim().min(1).max(300) }),
]);

const authenticate = async (request: Request) => {
  const { apiKeyCandidate } = extractCredentials(request);
  return Boolean(await verifyApiKey(apiKeyCandidate));
};

const parseRepoId = (raw: string) => {
  const repoId = Number(raw);
  return Number.isSafeInteger(repoId) && repoId > 0 ? repoId : null;
};

const notifyDomains = async () => {
  try {
    await client.notify('cp_domains', '');
  } catch {
    // The supervisor also refreshes on an interval.
  }
};

/** Hosts we serve ourselves — never claimable as a customer domain. */
const ownHosts = () => {
  const base = previewBaseHost(previewConfig.urlBase);
  return [base, 'pilot.alisamadii.com', 'alisamadii.com'].filter(Boolean);
};

export const PUT = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  if (!existsSync(join(repoDir(repoId), '.git'))) {
    return Response.json({ error: 'Workspace not found' }, { status: 404 });
  }
  if (!isLiveServable(repoId)) {
    return Response.json(
      { error: 'Only static sites can be served on a domain.' },
      { status: 409 }
    );
  }

  const base = previewBaseHost(previewConfig.urlBase);
  const existing = await listDomainsForRepo(repoId);

  try {
    if ('slug' in parsed.data) {
      const slug = validateSlug(parsed.data.slug);
      const host = slugHost(slug, previewConfig.urlBase);
      const taken = await getDomainRepoId(host);
      if (taken !== null && taken !== repoId) {
        return Response.json({ error: 'That name is taken.' }, { status: 409 });
      }
      // One free subdomain per project: drop the previous one.
      for (const old of existing) {
        if (old !== host && old.endsWith(`.${base}`)) {
          await removeDomainMapping(old);
        }
      }
      await setDomainMapping(host, repoId);
      await notifyDomains();
      return Response.json({
        host,
        url: previewConfig.urlBase.replace('{id}', slug),
      });
    }

    const host = validateCustomHost(normalizeHost(parsed.data.host), {
      ownHosts: ownHosts(),
    });
    if (host.endsWith(`.${base}`)) {
      // Custom domains must not squat the free-subdomain namespace.
      return Response.json({ error: 'That domain is not available.' }, { status: 409 });
    }
    const taken = await getDomainRepoId(host);
    if (taken !== null && taken !== repoId) {
      return Response.json(
        { error: 'That domain is already connected to another project.' },
        { status: 409 }
      );
    }
    // One custom domain per project: drop the previous non-free mapping.
    for (const old of existing) {
      if (old !== host && !old.endsWith(`.${base}`)) {
        await removeDomainMapping(old);
      }
    }
    await setDomainMapping(host, repoId);
    await notifyDomains();
    return Response.json({ host, url: `https://${host}` });
  } catch (error) {
    // domain-rules validators throw client-facing messages.
    const message = error instanceof Error ? error.message : 'Invalid domain.';
    return Response.json({ error: message }, { status: 422 });
  }
};

export const DELETE = async (
  request: Request,
  { params }: { params: Promise<{ repoId: string }> }
) => {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const repoId = parseRepoId((await params).repoId);
  if (!repoId) {
    return Response.json({ error: 'Invalid repoId' }, { status: 400 });
  }
  const hostParam = new URL(request.url).searchParams.get('host');
  if (hostParam) {
    const host = normalizeHost(hostParam);
    const owner = await getDomainRepoId(host);
    if (owner !== repoId) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    await removeDomainMapping(host);
  } else {
    await removeAllDomainsForRepo(repoId);
  }
  await notifyDomains();
  return Response.json({ deleted: true });
};
