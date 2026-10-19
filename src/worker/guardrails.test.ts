import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSessionForbiddenPaths, SESSION_PROMPT } from './guardrails';

// The denylist is the last line between an AI edit and a committed secret or a
// broken preview. Every pattern below guards a real incident class.

test('secrets: .env at the root and in any subfolder are forbidden', () => {
  assert.deepEqual(
    findSessionForbiddenPaths(['.env', '.env.local', 'apps/web/.env', 'src/.env.production']),
    ['.env', '.env.local', 'apps/web/.env', 'src/.env.production']
  );
});

test('a file merely containing "env" in its name is allowed', () => {
  assert.deepEqual(findSessionForbiddenPaths(['src/environment.ts', 'docs/env-setup.md']), []);
});

test('package.json is forbidden at any depth, but only the exact file', () => {
  assert.deepEqual(
    findSessionForbiddenPaths(['package.json', 'marketing/package.json', 'src/package.json.bak']),
    ['package.json', 'marketing/package.json']
  );
});

test('lockfiles for npm, pnpm, yarn and bun are forbidden', () => {
  assert.deepEqual(
    findSessionForbiddenPaths([
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'bun.lock',
      'app/pnpm-lock.yaml',
    ]),
    ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'app/pnpm-lock.yaml']
  );
});

test('lockfile rule is anchored: Block.astro, yarn.lock.bak, xpnpm-lock.yaml all pass', () => {
  assert.deepEqual(
    findSessionForbiddenPaths([
      'src/components/Block.astro',
      'src/lock.ts',
      'docs/yarn.lock.bak',
      'src/xpnpm-lock.yaml',
      'mypackage-lock.json',
    ]),
    []
  );
});

test('.github/ is forbidden only at the repo root', () => {
  assert.deepEqual(
    findSessionForbiddenPaths(['.github/workflows/ci.yml', 'docs/.github/x.md']),
    ['.github/workflows/ci.yml']
  );
});

test('node_modules is forbidden at any depth', () => {
  assert.deepEqual(
    findSessionForbiddenPaths(['node_modules/x/index.js', 'app/node_modules/y.js']),
    ['node_modules/x/index.js', 'app/node_modules/y.js']
  );
});

test('ordinary content, CMS and config-looking files pass through', () => {
  assert.deepEqual(
    findSessionForbiddenPaths([
      '_site.json',
      '_collections/team.json',
      'src/pages/index.astro',
      'public/images/hero.webp',
      'astro.config.mjs',
      'tsconfig.json',
    ]),
    []
  );
});

test('result preserves input order and only the offending paths', () => {
  assert.deepEqual(
    findSessionForbiddenPaths(['a.ts', 'package.json', 'b.ts', '.env']),
    ['package.json', '.env']
  );
  assert.deepEqual(findSessionForbiddenPaths([]), []);
});

test('session prompt carries the two forbidden actions and the no-image-read rule', () => {
  assert.match(SESSION_PROMPT, /FORBIDDEN — exactly two things/);
  assert.match(SESSION_PROMPT, /Redesigning an entire page/);
  assert.match(SESSION_PROMPT, /Creating or deleting pages or routes/);
  assert.match(SESSION_PROMPT, /Never open, read, or view image files/);
  assert.match(SESSION_PROMPT, /strictly valid JSON/);
});

test('session prompt forbids claiming a change that was not made (2026-10-18)', async () => {
  const { SESSION_PROMPT } = await import('../worker/guardrails');
  assert.match(SESSION_PROMPT, /Only say you changed something when your edit actually succeeded/);
  assert.match(SESSION_PROMPT, /already exists, say it is already there/);
});

test('session prompt tells replies to drop greetings and preamble (2026-10-19)', async () => {
  const { SESSION_PROMPT } = await import('../worker/guardrails');
  assert.match(SESSION_PROMPT, /Lead with the result in one short sentence/);
  assert.match(SESSION_PROMPT, /No greeting, no "Welcome"/);
});

test('session prompt forbids guessing between several matching elements (2026-10-18)', async () => {
  const { SESSION_PROMPT } = await import('./guardrails');
  assert.match(SESSION_PROMPT, /Never guess the target/);
  assert.match(SESSION_PROMPT, /lists the candidates by their current text/);
  assert.match(SESSION_PROMPT, /Never change several elements to satisfy a singular request/);
  assert.match(SESSION_PROMPT, /not a request to edit that page/);
});

test('session prompt: payment/login/checkout forms are never faked (round 3 #18b)', async () => {
  const { SESSION_PROMPT } = await import('./guardrails');
  assert.match(SESSION_PROMPT, /Payments, donations, logins, sign-ups, checkout: you cannot wire these up/);
  assert.match(SESSION_PROMPT, /Never add a form that only looks like it works/);
});

test('session prompt: AI cannot see images, so it defers photo reframing to an edited upload (2026-10-18)', async () => {
  const { SESSION_PROMPT } = await import('./guardrails');
  assert.match(SESSION_PROMPT, /cannot see any image/);
  assert.match(SESSION_PROMPT, /reposition, recenter, zoom, crop/);
  assert.match(SESSION_PROMPT, /upload the edited version to replace the current one/);
  assert.match(SESSION_PROMPT, /changing an element's or image's SIZE/);
});

test('session prompt: missing field/capability — judge, do it when simple, defer when tricky (2026-10-18)', async () => {
  const { SESSION_PROMPT } = await import('./guardrails');
  assert.match(SESSION_PROMPT, /If it is small and you can do it correctly and safely/);
  assert.match(SESSION_PROMPT, /tricky or site-wide logic you can't be sure about/);
  assert.match(SESSION_PROMPT, /do NOT invent a JSON field that nothing uses/);
  assert.match(SESSION_PROMPT, /needs their developer to set it up once/);
});
