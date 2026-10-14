import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildSkillBlock, loadSkill, parseSkillInvocation } from './skills';

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
  assert.doesNotMatch(buildSkillBlock({ ...skill, name: 'x' }, ''), /with:/);
});
