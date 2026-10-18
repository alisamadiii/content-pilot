import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectionHints,
  duplicateNote,
  findCollectionEntries,
  siteWideNote,
  todayLine,
} from './request-notes';

const site = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-notes-'));
  await mkdir(join(dir, '_collections'), { recursive: true });
  await writeFile(join(dir, '_collections/partners.json'), JSON.stringify([
    { name: 'Right to Learn Afghanistan', image: 'a.png' },
    { name: 'NSHSS', image: 'b.png' },
    { name: 'AGFAF', image: 'c.png' },
  ]));
  await writeFile(join(dir, '_collections/team.json'), JSON.stringify([
    { name: 'Mahdi Rahimi', role: 'Co-Founder & Mentor' },
    { name: 'Sara F', role: 'Director' },
  ]));
  await writeFile(join(dir, '_collections/workshops.json'), JSON.stringify([{ name: 'Web Development Workshop' }]));
  await writeFile(join(dir, '_collections/broken.json'), '{not json');
  await writeFile(join(dir, '_collections/site.json'), JSON.stringify({ title: 'EmpowerHer' }));
  return dir;
};

test('findCollectionEntries: EmpowerHer #15a — "AGFAF" resolves to partners.json entry 3 of 3', async () => {
  const dir = await site();
  const hits = await findCollectionEntries(dir, 'Move the AGFAF partner logo to the top');
  assert.deepEqual(hits, [{ label: 'AGFAF', file: '_collections/partners.json', index: 2, count: 3 }]);
});

test('findCollectionEntries: whole-word, case-insensitive, longest label first; short labels (<4) and non-arrays ignored', async () => {
  const dir = await site();
  const hits = await findCollectionEntries(dir, 'update right to learn afghanistan and sara f');
  assert.deepEqual(hits.map((h) => h.label), ['Right to Learn Afghanistan', 'Sara F']);
  assert.deepEqual(await findCollectionEntries(dir, 'NSHSSX is not a partner'), []);
  assert.deepEqual(await findCollectionEntries(dir, 'EmpowerHer rocks'), []);
});

test('findCollectionEntries: no _collections folder → []', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-notes-empty-'));
  assert.deepEqual(await findCollectionEntries(dir, 'anything about AGFAF'), []);
});

test('collectionHints: names file, position and the order rule', async () => {
  const dir = await site();
  const hits = await findCollectionEntries(dir, 'Move the AGFAF partner logo to the top');
  const text = collectionHints(hits);
  assert.match(text, /^Known content entries mentioned in this request:/);
  assert.match(text, /"AGFAF" is entry 3 of 3 in _collections\/partners\.json \(array order = display order/);
  assert.equal(collectionHints([]), '');
});

test('duplicateNote: EmpowerHer #13 — adding an existing team member asks instead of editing', async () => {
  const dir = await site();
  const message = '/manage-team add Mahdi Rahimi, group Executive Team, image https://example.org/mahdi.jpg';
  const hits = await findCollectionEntries(dir, message);
  const note = duplicateNote(message, hits);
  assert.match(note, /"Mahdi Rahimi" already exists in _collections\/team\.json/);
  assert.match(note, /Do NOT add a duplicate and do NOT change the existing entry/);
});

test('duplicateNote: update/remove requests that name an existing entry are not duplicates', async () => {
  const dir = await site();
  for (const message of [
    "Update Mahdi Rahimi's role to Lead Mentor",
    'remove Mahdi Rahimi from the team',
    'Move the AGFAF partner logo to the top',
  ]) {
    const hits = await findCollectionEntries(dir, message);
    assert.equal(duplicateNote(message, hits), '', message);
  }
  assert.equal(duplicateNote('add Someone New to the team', []), '');
});

test('siteWideNote: "everywhere" / "across the site" / "all pages" trigger, page-scoped requests do not', () => {
  assert.match(siteWideNote('Rename the program from Mentorship to Mentoring everywhere.'), /every file in the site/);
  assert.match(siteWideNote('change the brand colour across the whole site'), /replace_in_files/);
  assert.match(siteWideNote('update the footer on all pages'), /every file/);
  assert.equal(siteWideNote('change the heading on this page'), '');
  assert.equal(siteWideNote('do the same for the resources page'), '');
});

test('todayLine: ISO date from the given clock', () => {
  assert.equal(todayLine(new Date('2026-10-18T23:59:00Z')), 'Today is 2026-10-18. Use this exact date wherever a date defaults to today.');
});
