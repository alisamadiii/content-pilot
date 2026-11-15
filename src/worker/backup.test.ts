import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// GitHub backup of uploaded projects. The REST API is faked and the push
// target is a local bare repo, so this runs offline with real git.
const ws = mkdtempSync(join(tmpdir(), 'cp-backup-'));
const remotes = mkdtempSync(join(tmpdir(), 'cp-backup-remotes-'));
process.env.WORKSPACE_DIR = ws;
process.env.GIT_AUTHOR_NAME = 'Fallback Bot';
process.env.GIT_AUTHOR_EMAIL = 'bot@fallback.local';
process.env.GITHUB_APP_ID = '';
process.env.GITHUB_APP_PRIVATE_KEY = '';
process.env.GITHUB_BACKUP_ORG = 'acme-backups';
process.env.GITHUB_BACKUP_TOKEN = 'github_pat_SECRET123';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const P = '44444444-4444-4444-8444-444444444444';

const sh = (cwd: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Seed', '-c', 'user.email=seed@test', ...args],
    { cwd, encoding: 'utf8' }
  ).trim();

type Mod = typeof import('./backup');
let b: Mod;
let work: string;

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** Fake GitHub: `taken` maps repo name → description of an existing repo. */
const fakeApi = (taken: Record<string, string> = {}, calls: Call[] = []) =>
  (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });
    if (method === 'POST') {
      if (body.name in taken) return new Response('{}', { status: 422 });
      taken[body.name] = body.description;
      execFileSync('git', ['init', '-q', '--bare', join(remotes, `${body.name}.git`)]);
      return new Response('{}', { status: 201 });
    }
    if (method === 'GET') {
      const name = String(url).split('/').pop()!;
      return name in taken
        ? Response.json({ description: taken[name] })
        : new Response('{}', { status: 404 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

const remoteFor = (_org: string, repo: string) => join(remotes, `${repo}.git`);

before(async () => {
  b = await import('./backup');
  work = join(ws, P);
  execFileSync('git', ['init', '-q', work]);
  sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(work, 'index.html'), 'v1');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Import Acme Plumbing']);
});

test('backupRepoName slugs the name and suffixes the project id prefix', () => {
  assert.equal(b.backupRepoName('Acme Plumbing.zip', P), 'acme-plumbing-44444444');
  assert.equal(b.backupRepoName('!!!', P), 'site-44444444');
});

test('first backup creates a private org repo, pushes main, records state', async () => {
  const calls: Call[] = [];
  const sha = await b.backupProject(P, 'Acme Plumbing', { api: fakeApi({}, calls), remoteFor });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.github.com/orgs/acme-backups/repos');
  assert.equal(calls[0].body?.private, true);
  assert.equal(calls[0].body?.description, P);
  const bare = join(remotes, 'acme-plumbing-44444444.git');
  assert.equal(sh(bare, ['rev-parse', 'main']), sha);
  const state = await b.backupState(work);
  assert.deepEqual(state, {
    repo: 'acme-plumbing-44444444',
    url: 'https://github.com/acme-backups/acme-plumbing-44444444',
    sha,
    error: null,
  });
});

test('backup never adds an origin remote (upload mode must stay origin-less)', () => {
  assert.equal(sh(work, ['remote']), '');
});

test('later backups reuse the saved repo and fast-forward', async () => {
  writeFileSync(join(work, 'index.html'), 'v2');
  sh(work, ['commit', '-qam', 'Publish']);
  const calls: Call[] = [];
  const sha = await b.backupProject(P, 'ignored', { api: fakeApi({}, calls), remoteFor });
  assert.equal(calls.length, 0);
  assert.equal(sh(join(remotes, 'acme-plumbing-44444444.git'), ['rev-parse', 'main']), sha);
});

test('a taken name owned by someone else gets a suffix; our own is adopted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-backup-ensure-'));
  execFileSync('git', ['init', '-q', dir]);
  const taken = { 'acme-44444444': 'other-project' };
  assert.equal(await b.ensureBackupRepo(dir, P, 'acme', { api: fakeApi(taken) }), 'acme-44444444-2');

  const dir2 = mkdtempSync(join(tmpdir(), 'cp-backup-adopt-'));
  execFileSync('git', ['init', '-q', dir2]);
  const ours = { 'acme-44444444': P };
  const calls: Call[] = [];
  assert.equal(await b.ensureBackupRepo(dir2, P, 'acme', { api: fakeApi(ours, calls) }), 'acme-44444444');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('queueBackup swallows failures, records a redacted error, clears it on success', async () => {
  await b.queueBackup(P, 'x', {
    api: fakeApi(),
    remoteFor: () => 'https://github_pat_SECRET123@127.0.0.1:1/none.git',
  });
  const failed = await b.backupState(work);
  assert.ok(failed?.error);
  assert.equal(failed!.error!.includes('SECRET123'), false);

  await b.queueBackup(P, 'x', { api: fakeApi(), remoteFor });
  assert.equal((await b.backupState(work))?.error, null);
});

test('archiveBackupRepo PATCHes archived:true on the saved repo', async () => {
  const calls: Call[] = [];
  assert.equal(await b.archiveBackupRepo(work, { api: fakeApi({}, calls) }), true);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme-backups/acme-plumbing-44444444');
  assert.deepEqual(calls[0].body, { archived: true });
});
