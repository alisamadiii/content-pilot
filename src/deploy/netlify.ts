import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

/**
 * Netlify file-digest deploy: POST every file's sha1, Netlify answers with the
 * ones it doesn't already have, and only those are uploaded. No zip, and an
 * unchanged site re-deploys almost for free.
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
