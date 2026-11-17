import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

/**
 * Netlify deploys. Hub publishes use the Build API (buildOnNetlify): the source
 * zip is built on Netlify with the site's own env vars. deployFolder is the
 * file-digest deploy of an already-built folder (POST every file's sha1,
 * upload only the ones Netlify lacks).
 */

const API = 'https://api.netlify.com/api/v1';

export class NetlifyError extends Error {}

/** Every deployable file under `dir` → `/posix/path`. Git metadata is skipped. */
const listFiles = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.gitignore') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(dir);
  return out;
};

const toDeployPath = (dir: string, file: string) =>
  `/${relative(dir, file).split(sep).join('/')}`;

const netlify = async <T>(
  token: string,
  path: string,
  init: RequestInit
): Promise<T> => {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new NetlifyError(
      res.status === 401
        ? 'Netlify rejected the token. Reconnect Netlify and publish again.'
        : `Netlify: ${body?.message ?? `HTTP ${res.status}`}`
    );
  }
  return (await res.json()) as T;
};

/** Deploys the folder to the site (published to production). Returns the deploy id. */
export const deployFolder = async (params: {
  dir: string;
  siteId: string;
  token: string;
  title: string;
}): Promise<string> => {
  const { dir, siteId, token, title } = params;
  const files = await listFiles(dir);
  if (files.length === 0) throw new NetlifyError('The site has no files to deploy.');

  const digest: Record<string, string> = {};
  const byHash = new Map<string, string>();
  for (const file of files) {
    const hash = createHash('sha1').update(await readFile(file)).digest('hex');
    digest[toDeployPath(dir, file)] = hash;
    if (!byHash.has(hash)) byHash.set(hash, file);
  }

  const deploy = await netlify<{ id: string; required?: string[] }>(
    token,
    `/sites/${siteId}/deploys`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: digest, title }),
    }
  );

  // `required` lists sha1s; upload one file per missing hash.
  for (const hash of deploy.required ?? []) {
    const file = byHash.get(hash);
    if (!file) continue;
    await netlify(
      token,
      `/deploys/${deploy.id}/files${encodeURI(toDeployPath(dir, file))}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await readFile(file),
      }
    );
  }
  return deploy.id;
};

/**
 * Netlify Build API: uploads a source zip and Netlify installs, builds and
 * publishes it to production (netlify.toml decides the command and publish
 * dir). Returns the deploy id to follow.
 */
export const buildOnNetlify = async (params: {
  zip: Buffer;
  siteId: string;
  token: string;
  title: string;
}): Promise<string> => {
  const form = new FormData();
  form.set('title', params.title);
  form.set('zip', new Blob([new Uint8Array(params.zip)], { type: 'application/zip' }), 'site.zip');
  const build = await netlify<{ deploy_id?: string }>(
    params.token,
    `/sites/${params.siteId}/builds`,
    { method: 'POST', body: form }
  );
  if (!build.deploy_id) throw new NetlifyError('Netlify did not start a build.');
  return build.deploy_id;
};

const FAILED_STATES = new Set(['error', 'rejected']);

/** Polls a deploy until Netlify finishes it. Throws NetlifyError on a failed build. */
export const waitForNetlifyDeploy = async (
  token: string,
  deployId: string,
  { intervalMs = 5_000, timeoutMs = 30 * 60_000 } = {}
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const deploy = await netlify<{ state: string; error_message?: string | null }>(
      token,
      `/deploys/${deployId}`,
      { method: 'GET' }
    );
    if (deploy.state === 'ready') return;
    if (FAILED_STATES.has(deploy.state)) {
      throw new NetlifyError(
        `The Netlify build failed: ${deploy.error_message || 'see the deploy log on Netlify.'}`
      );
    }
    if (Date.now() > deadline) {
      throw new NetlifyError('Netlify is still building. Check the deploy on Netlify.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
