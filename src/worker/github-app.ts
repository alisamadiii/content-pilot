import { createSign } from 'crypto';
import { config } from './config';

/**
 * GitHub App auth ("Ali Samadi App") — per-repo installation tokens power
 * every clone/push. Hand-rolled: the protocol is one RS256 app JWT plus two
 * REST endpoints, not worth an SDK (this repo has zero Octokit deps).
 *
 * Resolution is live against GitHub (repo → installation, cached 10 min;
 * installation → token, cached 55 min of the token's 60-min life). Tokens are
 * never written into clones, so hour-plus sessions just keep pulling a
 * fresh-enough token from the cache per git op.
 */

export const isGithubAppConfigured = () =>
  !!(config.githubAppId && config.githubAppPrivateKey);

const b64url = (input: string) => Buffer.from(input).toString('base64url');

/** Short-lived (9 min) RS256 JWT authenticating as the app itself. */
export const appJwt = (): string => {
  const privateKey = Buffer.from(config.githubAppPrivateKey, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  // iat is backdated 60s to absorb clock skew (GitHub rejects future iat).
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.githubAppId })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
};

const ghHeaders = (auth: string) => ({
  Authorization: `Bearer ${auth}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-API-Version': '2022-11-28',
});

// ── Caches (process-lifetime Maps with expiry, matching resolve-repo's style) ──

const INSTALLATION_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 55 * 60 * 1000;

const repoKey = (owner: string, repo: string) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}`;

/** repo → installation id (null = app not installed there). */
const installationCache = new Map<
  string,
  { value: number | null; expiresAt: number }
>();

/** installation id → minted token. */
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/**
 * Every token this process ever minted, so sanitize() can redact them from
 * git error text even after they rotate out of the token cache.
 */
const mintedSecrets = new Set<string>();
export const githubAppSecrets = (): ReadonlySet<string> => mintedSecrets;

/**
 * Drop the caches behind a token after an auth failure (revoked installation,
 * rotated key). Returns true when the token was one of ours — the signal that
 * a retry with a freshly minted token is worth it (a PAT failure is not).
 */
export const bustTokenValue = (token: string): boolean => {
  let found = false;
  for (const [installationId, entry] of tokenCache) {
    if (entry.token === token) {
      tokenCache.delete(installationId);
      for (const [key, inst] of installationCache) {
        if (inst.value === installationId) installationCache.delete(key);
      }
      found = true;
    }
  }
  return found;
};

const installationIdFor = async (
  owner: string,
  repo: string
): Promise<number | null> => {
  const key = repoKey(owner, repo);
  const cached = installationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/installation`,
    { headers: ghHeaders(appJwt()) }
  ).catch(() => null);

  if (response?.status === 404) {
    installationCache.set(key, {
      value: null,
      expiresAt: Date.now() + INSTALLATION_TTL_MS,
    });
    return null;
  }
  if (!response?.ok) return null; // transient — don't cache as "not installed"

  const data = (await response.json().catch(() => null)) as { id?: number } | null;
  const value = data?.id ?? null;
  installationCache.set(key, {
    value,
    expiresAt: Date.now() + INSTALLATION_TTL_MS,
  });
  return value;
};

const mintToken = async (installationId: number): Promise<string | null> => {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  // No `permissions` body — the token carries the app's full (small)
  // permission set, so app-permission updates never 422 a stale subset here.
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: ghHeaders(appJwt()),
    }
  ).catch(() => null);
  if (!response?.ok) return null;

  const data = (await response.json().catch(() => null)) as {
    token?: string;
  } | null;
  if (!data?.token) return null;
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  mintedSecrets.add(data.token);
  return data.token;
};

/**
 * Installation token for owner/repo, or null when the app is unconfigured or
 * not installed there — callers fall back to the credential helper on null.
 */
export const installationTokenFor = async (
  owner: string,
  repo: string
): Promise<string | null> => {
  if (!isGithubAppConfigured() || !owner || !repo) return null;
  const installationId = await installationIdFor(owner, repo);
  if (!installationId) return null;
  return mintToken(installationId);
};

/**
 * Last-resort repoId → slug resolution: enumerate the app's installations and
 * their repos, matching by id. Only runs when resolve-repo has no hint and no
 * clone — results ride resolve-repo's own cache.
 */
export const resolveRepoIdViaApp = async (
  repoId: number
): Promise<{ owner: string; repo: string } | null> => {
  if (!isGithubAppConfigured()) return null;
  const installations = (await fetch(
    'https://api.github.com/app/installations?per_page=100',
    { headers: ghHeaders(appJwt()) }
  )
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])) as { id: number }[];

  for (const installation of installations) {
    const token = await mintToken(installation.id);
    if (!token) continue;
    for (let page = 1; page <= 10; page++) {
      const data = (await fetch(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        { headers: ghHeaders(token) }
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as {
        repositories?: { id: number; name: string; owner: { login: string } }[];
      } | null;
      const repos = data?.repositories ?? [];
      const match = repos.find((r) => r.id === repoId);
      if (match) return { owner: match.owner.login, repo: match.name };
      if (repos.length < 100) break;
    }
  }
  return null;
};
