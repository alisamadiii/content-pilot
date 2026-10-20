import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import {
  listSessionChanges,
  MAX_RESTORE_PATHS,
  normalizeRestorePaths,
  restoreFiles,
} from './restore-files';

const execFileAsync = promisify(execFile);
const sh = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd })).stdout.trim();

const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const commit = (cwd: string, message: string) =>
  sh(cwd, ['add', '-A']).then(() => sh(cwd, [...identity, 'commit', '-q', '-m', message]));

/**
 * A production repo (bare "origin" with main) + a session clone on a preview
 * branch that has: one committed turn (edited team.json, added an uploaded
 * image, deleted a story, edited package.json), plus one uncommitted edit
 * (hero) and one untracked addition (logo) from the current turn.
 */
const site = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cp-restore-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  await sh(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  await sh(root, ['init', '-q', '-b', 'main', work]);
  await mkdir(join(work, '_collections/hervoice'), { recursive: true });
  await mkdir(join(work, 'public/images/team'), { recursive: true });
  await mkdir(join(work, 'src/components'), { recursive: true });
  await writeFile(join(work, '_collections/team.json'), '[{"name":"Mahdi","photo":"/images/team/mahdi.webp"}]');
  await writeFile(join(work, '_collections/hervoice/story.md'), '# Story');
  await writeFile(join(work, 'public/images/team/mahdi.webp'), 'ORIGINAL-BYTES');
  await writeFile(join(work, 'src/components/Hero.astro'), '<h1>Welcome</h1>');
  await writeFile(join(work, 'package.json'), '{"name":"site"}');
  await writeFile(join(work, '.env'), 'KEY=prod');
  await commit(work, 'production');
  await sh(work, ['remote', 'add', 'origin', origin]);
  await sh(work, ['push', '-q', '-u', 'origin', 'main']);
  await sh(work, ['remote', 'set-head', 'origin', 'main']);
  const base = await sh(work, ['rev-parse', 'HEAD']);

  await sh(work, ['checkout', '-q', '-b', 'preview/abc']);
  // Turn 1 (committed)
  await writeFile(join(work, '_collections/team.json'), '[{"name":"Mahdi","photo":"/images/uploads/new.webp"}]');
  await mkdir(join(work, 'public/images/uploads'), { recursive: true });
  await writeFile(join(work, 'public/images/uploads/new.webp'), 'UPLOADED');
  await rm(join(work, '_collections/hervoice/story.md'));
  await writeFile(join(work, 'package.json'), '{"name":"site","broken":true}');
  await writeFile(join(work, '.env'), 'KEY=leaked');
  await commit(work, 'AI session edit: team photos');
  // Turn 2 (in progress, uncommitted)
  await writeFile(join(work, 'src/components/Hero.astro'), '<h1>Hello</h1>');
  await writeFile(join(work, 'public/images/uploads/logo.webp'), 'LOGO');
  return { work, base };
};

// ---------------------------------------------------------------- listing

test('listSessionChanges: committed turns, uncommitted edits and untracked files vs production', async () => {
  const { work, base } = await site();
  const result = await listSessionChanges(work);
  assert.equal(result.base, base);
  assert.deepEqual(result.files, [
    { path: '.env', status: 'M' },
    { path: '_collections/hervoice/story.md', status: 'D' },
    { path: '_collections/team.json', status: 'M' },
    { path: 'package.json', status: 'M' },
    { path: 'public/images/uploads/logo.webp', status: 'A' },
    { path: 'public/images/uploads/new.webp', status: 'A' },
    { path: 'src/components/Hero.astro', status: 'M' },
  ]);
});

test('listSessionChanges: scoped to a folder lists only files under it', async () => {
  const { work } = await site();
  const result = await listSessionChanges(work, ['public/images']);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['public/images/uploads/logo.webp', 'public/images/uploads/new.webp']
  );
});

test('listSessionChanges: an unchanged path lists nothing', async () => {
  const { work } = await site();
  const result = await listSessionChanges(work, ['public/images/team/mahdi.webp']);
  assert.deepEqual(result.files, []);
});

// ---------------------------------------------------------------- restoring

test('EmpowerHer revert: restoring _collections/team.json brings back the production bytes', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['_collections/team.json'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored, ['_collections/team.json']);
  assert.deepEqual(result.removed, []);
  assert.equal(
    await readFile(join(work, '_collections/team.json'), 'utf8'),
    '[{"name":"Mahdi","photo":"/images/team/mahdi.webp"}]'
  );
  // Other session work is untouched.
  assert.equal(await readFile(join(work, 'src/components/Hero.astro'), 'utf8'), '<h1>Hello</h1>');
  assert.ok(existsSync(join(work, 'public/images/uploads/new.webp')));
});

test('restoreFiles: a file the session added (uploaded image) is removed', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['public/images/uploads/new.webp'] });
  assert.ok(result.ok);
  assert.deepEqual(result.removed, ['public/images/uploads/new.webp']);
  assert.ok(!existsSync(join(work, 'public/images/uploads/new.webp')));
});

test('restoreFiles: a file the session deleted comes back', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['_collections/hervoice/story.md'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored, ['_collections/hervoice/story.md']);
  assert.equal(await readFile(join(work, '_collections/hervoice/story.md'), 'utf8'), '# Story');
});

test('restoreFiles: an uncommitted edit from the current turn is restored too', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['src/components/Hero.astro'] });
  assert.ok(result.ok);
  assert.equal(await readFile(join(work, 'src/components/Hero.astro'), 'utf8'), '<h1>Welcome</h1>');
});

test('restoreFiles: an untracked file from the current turn is removed', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['public/images/uploads/logo.webp'] });
  assert.ok(result.ok);
  assert.deepEqual(result.removed, ['public/images/uploads/logo.webp']);
  assert.ok(!existsSync(join(work, 'public/images/uploads/logo.webp')));
});

test('restoreFiles: a folder path restores everything under it (with and without trailing slash)', async () => {
  for (const folder of ['public/images', 'public/images/']) {
    const { work } = await site();
    const result = await restoreFiles({ dir: work, paths: [folder] });
    assert.ok(result.ok);
    assert.deepEqual(result.removed.sort(), [
      'public/images/uploads/logo.webp',
      'public/images/uploads/new.webp',
    ]);
    assert.equal(await readFile(join(work, 'public/images/team/mahdi.webp'), 'utf8'), 'ORIGINAL-BYTES');
    assert.equal(await readFile(join(work, '_collections/team.json'), 'utf8'), '[{"name":"Mahdi","photo":"/images/uploads/new.webp"}]');
  }
});

test('restoreFiles: ["."] undoes everything the session did except protected files', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['.'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored.sort(), [
    '_collections/hervoice/story.md',
    '_collections/team.json',
    'src/components/Hero.astro',
  ]);
  assert.deepEqual(result.removed.sort(), [
    'public/images/uploads/logo.webp',
    'public/images/uploads/new.webp',
  ]);
  assert.deepEqual(result.skipped.sort(), ['.env', 'package.json']);
  // Protected files keep the session's bytes — the editor never touches them.
  assert.equal(await readFile(join(work, 'package.json'), 'utf8'), '{"name":"site","broken":true}');
  assert.equal(await readFile(join(work, '.env'), 'utf8'), 'KEY=leaked');
  // Tree now equals production for everything else.
  const { files } = await listSessionChanges(work);
  assert.deepEqual(files.map((file) => file.path), ['.env', 'package.json']);
});

test('restoreFiles: protected paths asked for directly are skipped, not restored', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['package.json', '.env'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.skipped.sort(), ['.env', 'package.json']);
});

test('restoreFiles: an already-matching path reports nothing to restore', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['public/images/team/mahdi.webp'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, []);
});

test('restoreFiles: paths escaping the clone are refused before any git call', async () => {
  const { work } = await site();
  const result = await restoreFiles({ dir: work, paths: ['../other/secret'] });
  assert.ok(!result.ok);
  assert.match(result.error, /outside the site/);
});

test('restoreFiles: restored files are staged so a commit picks them up', async () => {
  const { work } = await site();
  await restoreFiles({ dir: work, paths: ['_collections/team.json'] });
  const status = await sh(work, ['status', '--porcelain', '--', '_collections/team.json']);
  assert.match(status, /^M {2}_collections\/team\.json$/);
});

// DELIBERATE ASSERTION CHANGE (upload-import feature): an origin-less clone is
// now a supported case — uploaded projects are local-only git repos whose
// local default branch stands in for origin/<default> (baseRef). Restoring
// without an origin therefore succeeds against local main instead of failing.
test('restoreFiles: an origin-less (uploaded) clone restores against local main', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-restore-noorigin-'));
  await sh(dir, ['init', '-q', '-b', 'main']);
  await writeFile(join(dir, 'a.txt'), 'x');
  await commit(dir, 'only');
  await writeFile(join(dir, 'a.txt'), 'edited');
  const result = await restoreFiles({ dir, paths: ['a.txt'] });
  assert.ok(result.ok);
  assert.deepEqual(result.restored, ['a.txt']);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'x');
});

// ---------------------------------------------------------------- path hygiene

test('normalizeRestorePaths: trims, strips ./ and leading slash, dedupes, drops trailing slash', () => {
  assert.deepEqual(
    normalizeRestorePaths([' ./_collections/team.json ', '/public/images/', 'public/images', '']),
    { ok: true, paths: ['_collections/team.json', 'public/images'] }
  );
});

test('normalizeRestorePaths: "." (or "./") collapses the list to the whole site', () => {
  assert.deepEqual(normalizeRestorePaths(['src/a.astro', '.']), { ok: true, paths: ['.'] });
  assert.deepEqual(normalizeRestorePaths(['./']), { ok: true, paths: ['.'] });
});

test('normalizeRestorePaths: rejects .. segments, backslashes and empty lists', () => {
  assert.equal(normalizeRestorePaths(['src/../../x']).ok, false);
  assert.equal(normalizeRestorePaths(['..']).ok, false);
  assert.equal(normalizeRestorePaths(['src\\a.astro']).ok, false);
  assert.equal(normalizeRestorePaths(['', '  ']).ok, false);
});

test('normalizeRestorePaths: refuses more than MAX_RESTORE_PATHS entries', () => {
  const many = Array.from({ length: MAX_RESTORE_PATHS + 1 }, (_, i) => `f${i}.txt`);
  const result = normalizeRestorePaths(many);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /\["\."\]/);
});
