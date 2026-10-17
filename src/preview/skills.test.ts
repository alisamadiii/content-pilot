import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  bareSkillRequest,
  buildSkillBlock,
  loadSkill,
  parseSkillInvocation,
  scrubSkillJargon,
} from './skills';

test('bareSkillRequest tells the model to ask before touching files', () => {
  assert.match(bareSkillRequest('add-page'), /Do not read or change any file yet/);
});

test('scrubSkillJargon strips the skill token, "using the … skill" and backticks', () => {
  assert.equal(
    scrubSkillJargon(
      "I can help you build the new page (`/bathroom-remodeling`) using the `/add-page` skill. Shall we create it now?",
      'add-page'
    ),
    'I can help you build the new page (/bathroom-remodeling). Shall we create it now?'
  );
  assert.equal(scrubSkillJargon('Done with /manage-faqs .', 'manage-faqs'), 'Done.');
  assert.equal(scrubSkillJargon('I updated `site.ts` for you!', null), 'I updated site.ts for you!');
});

test('parseSkillInvocation reads /name and the rest of the message', () => {
  assert.deepEqual(parseSkillInvocation('/add-page Careers page'), {
    name: 'add-page',
    rest: 'Careers page',
  });
  assert.deepEqual(parseSkillInvocation('  /Manage-FAQs  '), { name: 'manage-faqs', rest: '' });
  assert.deepEqual(parseSkillInvocation('/seo_setup\nline two'), {
    name: 'seo_setup',
    rest: 'line two',
  });
});

test('parseSkillInvocation ignores ordinary messages and paths', () => {
  assert.equal(parseSkillInvocation('change the headline'), null);
  assert.equal(parseSkillInvocation('see /about page'), null);
  assert.equal(parseSkillInvocation('/images/x.png is broken'), null);
  assert.equal(parseSkillInvocation('/'), null);
});

test('loadSkill reads SKILL.md without frontmatter, root before app folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-skill-'));
  const app = join(dir, 'site');
  await mkdir(join(dir, '.claude/skills/add-page'), { recursive: true });
  await mkdir(join(app, '.claude/skills/add-page'), { recursive: true });
  await mkdir(join(app, '.claude/skills/only-app'), { recursive: true });
  await mkdir(join(dir, '.gemini/skills/gem'), { recursive: true });
  await writeFile(
    join(dir, '.claude/skills/add-page/SKILL.md'),
    '---\nname: add-page\ndescription: Adds a page\n---\n\n# Root version\nDo X.'
  );
  await writeFile(join(app, '.claude/skills/add-page/SKILL.md'), '# App version');
  await writeFile(join(app, '.claude/skills/only-app/SKILL.md'), 'App only');
  await writeFile(join(dir, '.gemini/skills/gem/SKILL.md'), 'Gemini-only skill');
  assert.deepEqual(await loadSkill(dir, app, 'add-page'), {
    name: 'add-page',
    body: '# Root version\nDo X.',
    dir: '.claude/skills/add-page',
  });
  assert.deepEqual(await loadSkill(dir, app, 'only-app'), {
    name: 'only-app',
    body: 'App only',
    dir: 'site/.claude/skills/only-app',
  });
  assert.deepEqual(await loadSkill(dir, app, 'gem'), {
    name: 'gem',
    body: 'Gemini-only skill',
    dir: '.gemini/skills/gem',
  });
  assert.equal(await loadSkill(dir, app, 'missing'), null);
  assert.equal(await loadSkill(dir, app, '../etc'), null);
});

test('buildSkillBlock wraps the body with the invocation and precedence note', () => {
  const skill = { name: 'add-page', body: 'Do X.', dir: '.gemini/skills/add-page' };
  const block = buildSkillBlock(skill, 'Careers');
  assert.match(block, /invoked the skill `\/add-page` with: "Careers"/);
  assert.match(block, /override the general editing limits/);
  assert.match(block, /relative to the skill's own folder \(`\.gemini\/skills\/add-page\/`\)/);
  assert.match(block, /--- skill: add-page ---\nDo X\.\n--- end of skill ---/);
  assert.match(block, /friendly website editor talking to the person who runs this site/);
  assert.match(block, /Never say "the site owner", "invoked", "skill"/);
  assert.doesNotMatch(buildSkillBlock({ ...skill, name: 'x' }, ''), /with:/);
});

// ---------------------------------------------------------------------------
// Catalog (hub "/" menu)
// ---------------------------------------------------------------------------

import { listSkills, parseSkillFrontmatter, scanSkillsDir } from './skills';

test('parseSkillFrontmatter reads name + description, stripping quotes', () => {
  assert.deepEqual(
    parseSkillFrontmatter('---\nname: add-page\ndescription: "Adds a page"\nextra: ignored\n---\n# Body'),
    { name: 'add-page', description: 'Adds a page' }
  );
  assert.deepEqual(parseSkillFrontmatter("---\nname: 'x'\n---"), { name: 'x', description: '' });
});

test('parseSkillFrontmatter rejects files without frontmatter or without a name', () => {
  assert.equal(parseSkillFrontmatter('# Just a heading\nname: nope'), null);
  assert.equal(parseSkillFrontmatter('---\ndescription: only\n---'), null);
  assert.equal(parseSkillFrontmatter(''), null);
  // Frontmatter must open on the very first line.
  assert.equal(parseSkillFrontmatter('\n---\nname: x\n---'), null);
});

test('scanSkillsDir lists valid skills only; missing dir and bad entries are skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-skillcat-'));
  await mkdir(join(dir, '.claude/skills/b-skill'), { recursive: true });
  await mkdir(join(dir, '.claude/skills/a-skill'), { recursive: true });
  await mkdir(join(dir, '.claude/skills/no-md'), { recursive: true });
  await mkdir(join(dir, '.claude/skills/bad-md'), { recursive: true });
  await writeFile(join(dir, '.claude/skills/b-skill/SKILL.md'), '---\nname: b-skill\ndescription: B\n---');
  await writeFile(join(dir, '.claude/skills/a-skill/SKILL.md'), '---\nname: a-skill\ndescription: A\n---');
  await writeFile(join(dir, '.claude/skills/bad-md/SKILL.md'), 'no frontmatter');
  await writeFile(join(dir, '.claude/skills/stray-file'), 'x');
  const found = await scanSkillsDir(dir);
  assert.deepEqual(
    found.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: 'a-skill', description: 'A' }, { name: 'b-skill', description: 'B' }]
  );
  assert.deepEqual(await scanSkillsDir(join(dir, 'nope')), []);
});

test('listSkills merges app-folder and root skills, root winning, sorted by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-skilllist-'));
  // App skills scan first, so insertion order is zeta/shared then alpha —
  // the result must still come back sorted.
  for (const [base, name, desc] of [
    [join(dir, 'site'), 'zeta', 'app zeta'],
    [join(dir, 'site'), 'shared', 'app shared'],
    [dir, 'alpha', 'root alpha'],
    [dir, 'shared', 'root shared'],
  ]) {
    await mkdir(join(base, '.claude/skills', name), { recursive: true });
    await writeFile(join(base, '.claude/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---`);
  }
  assert.deepEqual(await listSkills(dir, 'site'), [
    { name: 'alpha', description: 'root alpha' },
    { name: 'shared', description: 'root shared' },
    { name: 'zeta', description: 'app zeta' },
  ]);
  // No app folder configured → root only.
  assert.deepEqual(await listSkills(dir, null), [
    { name: 'alpha', description: 'root alpha' },
    { name: 'shared', description: 'root shared' },
  ]);
});
