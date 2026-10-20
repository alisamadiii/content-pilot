import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// GitHub App auth plumbing in worker/git: token-parameterized auth args,
// provider fallback order, and sanitize covering minted tokens. Local bare
// origin, no network — same pattern as git.integration.test.ts.
const ws = mkdtempSync(join(tmpdir(), 'cp-gitapp-'));
process.env.WORKSPACE_DIR = ws;
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_APP_PRIVATE_KEY = '';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

type GitMod = typeof import('./git');
type AppMod = typeof import('./github-app');
let g: GitMod;
let app: AppMod;
let localClone: string;
let githubClone: string;

before(async () => {
  g = await import('./git');
  app = await import('./github-app');
  const origin = join(ws, 'origin.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  localClone = join(ws, 'local-clone');
  execFileSync('git', ['clone', '-q', origin, localClone]);
  // A clone whose origin looks like GitHub (never fetched in this test).
  githubClone = join(ws, 'github-clone');
  execFileSync('git', ['clone', '-q', origin, githubClone]);
  execFileSync(
    'git',
    ['remote', 'set-url', 'origin', 'https://github.com/acme/site.git'],
    { cwd: githubClone }
  );
});

test('gitAuthArgs scopes the Basic header to github.com and is empty without a token', () => {
  assert.deepEqual(g.gitAuthArgs(''), []);
  const args = g.gitAuthArgs('tok_123');
  assert.equal(args[1], 'credential.helper=');
  const header = args[3];
  assert.ok(header.startsWith('http.https://github.com/.extraHeader=Authorization: Basic '));
  const b64 = header.split('Basic ')[1];
  assert.equal(Buffer.from(b64, 'base64').toString(), 'x-access-token:tok_123');
});

test('parseRemote lives in worker/git and handles https and ssh forms', () => {
  assert.deepEqual(g.parseRemote('https://github.com/acme/site.git'), {
    owner: 'acme',
    repo: 'site',
  });
  assert.deepEqual(g.parseRemote('git@github.com:acme/site.git'), {
    owner: 'acme',
    repo: 'site',
  });
  assert.equal(g.parseRemote(join(ws, 'origin.git')), null);
});

// STALE ASSERTIONS UPDATED (deliberate behavior change, GitHub App cutover
// 2026-10-20): the legacy PAT fallback was removed — empty auth now means the
// system credential helper. The three fallback tests below previously expected
// 'ghp_legacy_pat_456'; the sanitize test previously asserted PAT redaction.

test('authFor falls back to empty auth (credential helper) for a non-GitHub origin', async () => {
  assert.equal(await g.authFor(localClone)(), '');
});

test('authFor falls back to empty auth for a GitHub origin when the app is unconfigured', async () => {
  // installationTokenFor short-circuits to null without app creds — no fetch.
  assert.equal(await g.authFor(githubClone)(), '');
});

test('authForRepo returns empty auth when the app is unconfigured', async (t) => {
  assert.equal(await g.authForRepo('acme', 'site')(), '');
  t.diagnostic('installation-token preference is covered in github-app.test.ts');
});

test('sanitize redacts only minted installation tokens and auth headers', () => {
  app.githubAppSecrets(); // module loaded
  // A token never minted by this process is not redacted…
  assert.equal(g.sanitize('push failed: ghs_not_ours'), 'push failed: ghs_not_ours');
  // …while Basic auth headers always are.
  assert.equal(
    g.sanitize('fatal: push rejected Authorization: Basic abc='),
    'fatal: push rejected Authorization: [REDACTED]'
  );
});
