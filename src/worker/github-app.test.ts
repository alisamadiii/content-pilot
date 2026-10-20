import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createVerify, generateKeyPairSync } from 'crypto';

// Env is read by worker/config at import, so it's pinned before the dynamic
// import — same pattern as git.integration.test.ts.
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
process.env.GITHUB_APP_ID = '424242';
process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
).toString('base64');

type Mod = typeof import('./github-app');
let app: Mod;

const realFetch = globalThis.fetch;
type FetchCall = { url: string; init?: RequestInit };
let calls: FetchCall[] = [];
let responses: ((url: string) => Response | null)[] = [];

const mockFetch = (handler: (url: string) => Response | null) => {
  responses = [handler];
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const res = responses[0](url);
    if (!res) throw new Error(`unmocked fetch: ${url}`);
    return res;
  }) as typeof fetch;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

before(async () => {
  app = await import('./github-app');
});

test('appJwt is a valid RS256 JWT with backdated iat and app id issuer', () => {
  const jwt = app.appJwt();
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'RS256',
    typ: 'JWT',
  });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  assert.equal(claims.iss, '424242');
  assert.ok(claims.iat <= now - 55 && claims.iat >= now - 65);
  assert.ok(claims.exp > now && claims.exp <= now + 540);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')));
});

test('installationTokenFor resolves installation, mints, caches, and registers the secret', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockFetch((url) => {
    if (url === 'https://api.github.com/repos/acme/site/installation') {
      return json({ id: 777 });
    }
    if (url === 'https://api.github.com/app/installations/777/access_tokens') {
      return json({ token: 'ghs_minted_abc', expires_at: '2099-01-01T00:00:00Z' }, 201);
    }
    return null;
  });

  assert.equal(await app.installationTokenFor('acme', 'site'), 'ghs_minted_abc');
  const networkCalls = calls.length;
  // Second call rides both caches — zero extra network.
  assert.equal(await app.installationTokenFor('acme', 'site'), 'ghs_minted_abc');
  assert.equal(calls.length, networkCalls);
  assert.ok(app.githubAppSecrets().has('ghs_minted_abc'));
});

test('installationTokenFor is null (and cached) when the app is not installed on the repo', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockFetch((url) =>
    url.includes('/repos/acme/uncovered/installation')
      ? json({ message: 'Not Found' }, 404)
      : null
  );
  assert.equal(await app.installationTokenFor('acme', 'uncovered'), null);
  const networkCalls = calls.length;
  assert.equal(await app.installationTokenFor('acme', 'uncovered'), null);
  assert.equal(calls.length, networkCalls); // 404 is cached, no re-lookup
});

test('bustTokenValue drops a minted token (true) and ignores foreign tokens (false)', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let mintCount = 0;
  mockFetch((url) => {
    if (url === 'https://api.github.com/repos/acme/bustme/installation') {
      return json({ id: 888 });
    }
    if (url === 'https://api.github.com/app/installations/888/access_tokens') {
      mintCount += 1;
      return json({ token: `ghs_rotating_${mintCount}`, expires_at: 'x' }, 201);
    }
    return null;
  });

  assert.equal(await app.installationTokenFor('acme', 'bustme'), 'ghs_rotating_1');
  assert.equal(app.bustTokenValue('ghs_rotating_1'), true);
  // Busted → the next ask re-resolves and re-mints.
  assert.equal(await app.installationTokenFor('acme', 'bustme'), 'ghs_rotating_2');
  assert.equal(app.bustTokenValue('not_ours'), false);
});

test('resolveRepoIdViaApp matches a repo id across installations', async (t) => {
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  mockFetch((url) => {
    if (url.startsWith('https://api.github.com/app/installations?')) {
      return json([{ id: 901 }]);
    }
    if (url === 'https://api.github.com/app/installations/901/access_tokens') {
      return json({ token: 'ghs_enum', expires_at: 'x' }, 201);
    }
    if (url.startsWith('https://api.github.com/installation/repositories')) {
      return json({
        repositories: [
          { id: 1, name: 'other', owner: { login: 'acme' } },
          { id: 555, name: 'found-it', owner: { login: 'acme' } },
        ],
      });
    }
    return null;
  });
  assert.deepEqual(await app.resolveRepoIdViaApp(555), {
    owner: 'acme',
    repo: 'found-it',
  });
  assert.equal(await app.resolveRepoIdViaApp(999999), null);
});
