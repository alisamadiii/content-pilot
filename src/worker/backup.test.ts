import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
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

// 2026-11-18: hub "GitHub" dialog pulls the backup repo's latest commit into
// the workspace. main must become that exact commit (no commit on top), with
// preview branches gone, no origin remote and cp.backupSha recorded.
test('fetchBackup reads the remote head without touching main', async () => {
  const bare = join(remotes, 'acme-relinked.git');
  const clone = mkdtempSync(join(tmpdir(), 'cp-backup-clone-'));
  execFileSync('git', ['clone', '-q', '-b', 'main', bare, clone]);
  writeFileSync(join(clone, 'index.html'), 'v3 from github');
  writeFileSync(join(clone, 'about.html'), 'new page');
  sh(clone, ['add', '-A']);
  sh(clone, ['commit', '-qm', 'Edit on GitHub']);
  sh(clone, ['push', '-q', 'origin', 'HEAD:main']);
  const remoteSha = sh(bare, ['rev-parse', 'main']);

  const before = sh(work, ['rev-parse', 'main']);
  const head = await b.fetchBackup(P, 'acme-relinked', { remoteFor });
  assert.deepEqual(head, { sha: remoteSha, message: 'Edit on GitHub' });
  assert.equal(sh(work, ['rev-parse', 'main']), before);
  assert.equal(sh(work, ['rev-parse', 'refs/cp/backup']), remoteSha);
  assert.equal(sh(work, ['remote']), '');
});

test('exportFetchedBackup copies the fetched tree into staging', async () => {
  const zip = join(ws, 'pull.zip');
  const staging = join(ws, 'pull-staging');
  const { files } = await b.exportFetchedBackup(P, zip, staging);
  assert.equal(files, 2);
  assert.equal(readFileSync(join(staging, 'about.html'), 'utf8'), 'new page');
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), 'v2');
});

test('mirrorBackup makes main the fetched commit, drops preview branches, keeps ignored files', async () => {
  sh(work, ['checkout', '-qb', 'preview/s9']);
  writeFileSync(join(work, 'draft.html'), 'unpublished');
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-qm', 'AI edit']);
  mkdirSync(join(work, 'node_modules'), { recursive: true });
  writeFileSync(join(work, 'node_modules', 'x.js'), '');
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  writeFileSync(join(work, 'scratch.txt'), 'untracked');

  const remoteSha = sh(join(remotes, 'acme-relinked.git'), ['rev-parse', 'main']);
  const { sha } = await b.mirrorBackup(P, 'acme-relinked');
  assert.equal(sha, remoteSha);
  assert.equal(sh(work, ['rev-parse', 'HEAD']), remoteSha);
  assert.equal(sh(work, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
  assert.equal(sh(work, ['log', '--format=%s', '-1']), 'Edit on GitHub');
  assert.equal(sh(work, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']), 'main');
  assert.equal(readFileSync(join(work, 'index.html'), 'utf8'), 'v3 from github');
  assert.equal(existsSync(join(work, 'draft.html')), false);
  assert.equal(existsSync(join(work, 'scratch.txt')), false);
  assert.equal(existsSync(join(work, '.gitignore')), false);
  assert.equal(existsSync(join(work, 'node_modules', 'x.js')), true);
  assert.throws(() => sh(work, ['rev-parse', '--verify', 'refs/cp/backup']));
  assert.equal(sh(work, ['remote']), '');
  assert.deepEqual(await b.backupState(work), {
    repo: 'acme-relinked',
    url: 'https://github.com/acme-backups/acme-relinked',
    sha: remoteSha,
    error: null,
  });
});

test('dropFetchedBackup forgets the ref after a failed pull', async () => {
  await b.fetchBackup(P, 'acme-relinked', { remoteFor });
  await b.dropFetchedBackup(P);
  assert.throws(() => sh(work, ['rev-parse', '--verify', 'refs/cp/backup']));
});

test('fetchBackup redacts the token on failure and refuses bad names', async () => {
  await assert.rejects(
    b.fetchBackup(P, 'acme-relinked', {
      remoteFor: () => 'https://github_pat_SECRET123@127.0.0.1:1/none.git',
    }),
    (error: Error) => !error.message.includes('SECRET123')
  );
  await assert.rejects(b.fetchBackup(P, 'other/repo', { remoteFor }), /Invalid backup repo name/);
});
