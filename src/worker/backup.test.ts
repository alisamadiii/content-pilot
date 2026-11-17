import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// GitHub backup of uploaded projects. The hub names the repo; pilot only
// pushes. The push target is a local bare repo, so this runs offline with real git.
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

const remoteFor = (_org: string, repo: string) => join(remotes, `${repo}.git`);
const bareRepo = (repo: string) =>
  execFileSync('git', ['init', '-q', '--bare', join(remotes, `${repo}.git`)]);

before(async () => {
  b = await import('./backup');
  work = join(ws, P);
  execFileSync('git', ['init', '-q', work]);
  sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(work, 'index.html'), 'v1');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'Import Acme Plumbing']);
});

test('pushes main to the repo the hub named and records state', async () => {
  bareRepo('acme-plumbing-44444444');
  const sha = await b.backupProject(P, 'acme-plumbing-44444444', { remoteFor });
  assert.equal(sh(join(remotes, 'acme-plumbing-44444444.git'), ['rev-parse', 'main']), sha);
  assert.deepEqual(await b.backupState(work), {
    repo: 'acme-plumbing-44444444',
    url: 'https://github.com/acme-backups/acme-plumbing-44444444',
    sha,
    error: null,
  });
});

test('backup never adds an origin remote (upload mode must stay origin-less)', () => {
  assert.equal(sh(work, ['remote']), '');
});

test('later backups fast-forward the same repo', async () => {
  writeFileSync(join(work, 'index.html'), 'v2');
  sh(work, ['commit', '-qam', 'Publish']);
  const sha = await b.backupProject(P, 'acme-plumbing-44444444', { remoteFor });
  assert.equal(sh(join(remotes, 'acme-plumbing-44444444.git'), ['rev-parse', 'main']), sha);
});

test('a re-link pushes to the new repo and records it as the target', async () => {
  bareRepo('acme-relinked');
  const sha = await b.backupProject(P, 'acme-relinked', { remoteFor });
  assert.equal(sh(join(remotes, 'acme-relinked.git'), ['rev-parse', 'main']), sha);
  assert.equal((await b.backupState(work))?.repo, 'acme-relinked');
});

test('rejects repo names that are not a plain name in the org', async () => {
  for (const bad of ['', '.', '..', 'other-org/repo', 'a b', 'https://evil.test/x', 'x'.repeat(101)]) {
    assert.equal(b.isBackupRepoName(bad), false, bad);
    await assert.rejects(b.backupProject(P, bad, { remoteFor }), /Invalid backup repo name/);
  }
  assert.equal(b.isBackupRepoName('Acme_site.v2-1'), true);
});

test('queueBackup swallows failures, records a redacted error, clears it on success', async () => {
  await b.queueBackup(P, 'acme-relinked', {
    remoteFor: () => 'https://github_pat_SECRET123@127.0.0.1:1/none.git',
  });
  const failed = await b.backupState(work);
  assert.ok(failed?.error);
  assert.equal(failed!.error!.includes('SECRET123'), false);

  await b.queueBackup(P, 'acme-relinked', { remoteFor });
  assert.equal((await b.backupState(work))?.error, null);
});
