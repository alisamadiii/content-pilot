import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildRepoContext,
  collectPageBundle,
  resolvePageFile,
  routeMentionedIn,
} from './repo-context';

/** A minimal Astro site with the shapes the context builder looks for. */
const astroFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-repo-'));
  const files: Record<string, string> = {
    'package.json': '{"dependencies":{"astro":"^5"}}',
    'astro.config.mjs': 'export default {}',
    '_site.json': '{}',
    '_collections/team.json': '[]',
    'src/pages/index.astro': '---\nimport Hero from "@/components/hero.astro";\n---\n<Hero />',
    'src/pages/about.astro':
      '---\nimport Layout from "@/layouts/Layout.astro";\nimport Story from "@/components/about/story.astro";\nimport Button from "@/components/ui/button.astro";\nimport { x } from "../lib/site";\n---\n<Layout><Story /><Button /></Layout>',
    'src/pages/events/[slug].astro': '<h1>event</h1>',
    'src/pages/api/hook.ts': 'export const GET = () => {}',
    'src/layouts/Layout.astro': '<slot />',
    'src/lib/site.ts': 'export const x = 1',
    'src/components/hero.astro': '<h1>Hi</h1>',
    'src/components/about/story.astro': '<p>The person behind the price</p>',
    'src/components/ui/button.astro': '<button />',
    'public/images/team/a.webp': 'x',
    'public/images/team/b.webp': 'x',
    'AGENTS.md': '# Rules\n- Edit `src/data/site.ts` only.',
    'CLAUDE.md': '# Older copy',
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  return dir;
};

test('buildRepoContext maps Astro routes to files and lists site facts', async () => {
  const dir = await astroFixture();
  const ctx = await buildRepoContext(dir);
  assert.equal(ctx.framework, 'astro');
  assert.equal(ctx.routes.get('/'), 'src/pages/index.astro');
  assert.equal(ctx.routes.get('/about'), 'src/pages/about.astro');
  assert.equal(ctx.routes.get('/events/[slug]'), 'src/pages/events/[slug].astro');
  assert.equal(ctx.routes.has('/api/hook'), false);
  assert.deepEqual(ctx.cmsFiles, ['_site.json', '_collections/team.json']);
  assert.ok(ctx.components.includes('src/components/about/story.astro'));
  assert.ok(!ctx.components.includes('src/components/ui/button.astro'));
  assert.deepEqual(ctx.imageDirs, [{ dir: 'public/images/team', count: 2 }]);
  assert.match(ctx.text, /- \/about → src\/pages\/about\.astro/);
  assert.match(ctx.text, /`_site\.json`/);
  assert.match(ctx.text, /`public\/images\/team` \(2\)/);
  assert.equal(ctx.agentNotes, '# Rules\n- Edit `src/data/site.ts` only.');
  assert.match(ctx.text, /Developer notes for this site[\s\S]*Edit `src\/data\/site\.ts` only/);
  assert.doesNotMatch(ctx.text, /Older copy/);
  assert.ok(ctx.text.length < 2000, `context too long: ${ctx.text.length}`);
});

test('buildRepoContext falls back to CLAUDE.md and omits the notes block when neither exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-repo-'));
  await writeFile(join(dir, 'package.json'), '{}');
  assert.equal((await buildRepoContext(dir)).agentNotes, '');
  assert.doesNotMatch((await buildRepoContext(dir)).text, /Developer notes/);
  await writeFile(join(dir, 'CLAUDE.md'), 'Only claude notes');
  assert.equal((await buildRepoContext(dir)).agentNotes, 'Only claude notes');
});

// DELIBERATE CHANGE (root-only sites): app-folder override removed; the
// subfolder-prefix case went with it.

// DELIBERATE CHANGE (static-only pivot): Next.js App/Pages router maps were
// removed with Next support. A Next repo now maps no framework routes.
test('buildRepoContext no longer maps Next app/pages routers (Next unsupported)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-repo-'));
  const files: Record<string, string> = {
    'package.json': '{"dependencies":{"next":"15"}}',
    'app/page.tsx': '',
    'app/(marketing)/about/page.tsx': '',
    'pages/contact.tsx': '',
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  const ctx = await buildRepoContext(dir);
  assert.equal(ctx.framework, null);
  assert.equal(ctx.routes.has('/about'), false);
  assert.equal(ctx.routes.has('/contact'), false);
});

test('resolvePageFile matches exact and dynamic routes', () => {
  const routes = new Map([
    ['/', 'src/pages/index.astro'],
    ['/events/[slug]', 'src/pages/events/[slug].astro'],
    ['/docs/[...rest]', 'src/pages/docs/[...rest].astro'],
  ]);
  assert.equal(resolvePageFile(routes, '/'), 'src/pages/index.astro');
  assert.equal(resolvePageFile(routes, '/events/summer-gala/'), 'src/pages/events/[slug].astro');
  assert.equal(resolvePageFile(routes, '/docs/a/b/c'), 'src/pages/docs/[...rest].astro');
  assert.equal(resolvePageFile(routes, '/missing'), null);
});

test('routeMentionedIn finds a page named in the message, never the current one', () => {
  const routes = new Map([
    ['/', 'i'],
    ['/about', 'a'],
    ['/contact', 'c'],
    ['/our-team', 't'],
    ['/events/[slug]', 'e'],
  ]);
  assert.equal(routeMentionedIn('add this to the about page', routes, '/'), '/about');
  assert.equal(routeMentionedIn('update the About Page headline', routes, '/about'), null);
  assert.equal(routeMentionedIn('fix the our team photo', routes, '/'), '/our-team');
  assert.equal(routeMentionedIn('back on the homepage, change the title', routes, '/contact'), '/');
  assert.equal(routeMentionedIn('change the headline', routes, '/'), null);
  assert.equal(routeMentionedIn('the events list', routes, '/'), null);
});

test('collectPageBundle inlines the page plus its content components only', async () => {
  const dir = await astroFixture();
  const bundle = await collectPageBundle(dir, 'src/pages/about.astro', 40_000);
  assert.ok(bundle);
  assert.deepEqual(
    bundle.files.map((f) => f.path),
    ['src/pages/about.astro', 'src/components/about/story.astro']
  );
  assert.match(bundle.files[1].content, /person behind the price/);
  assert.deepEqual(bundle.omitted, []);
});

test('collectPageBundle respects the byte budget and reports omissions', async () => {
  const dir = await astroFixture();
  // Room for the page itself but not for the component it imports.
  const pageLength = (await readFile(join(dir, 'src/pages/about.astro'), 'utf8')).length;
  const tight = await collectPageBundle(dir, 'src/pages/about.astro', pageLength + 5);
  assert.ok(tight);
  assert.deepEqual(tight.files.map((f) => f.path), ['src/pages/about.astro']);
  assert.deepEqual(tight.omitted, ['src/components/about/story.astro']);
  assert.equal(await collectPageBundle(dir, 'src/pages/about.astro', 10), null);
  assert.equal(await collectPageBundle(dir, 'src/pages/nope.astro', 1000), null);
});

// ------------------------------------------------- value-position mentions (2026-10-18)

test('routeMentionedIn: a route name used as the NEW VALUE is not a page mention', () => {
  const routes = new Map([
    ['/', 'src/pages/index.astro'],
    ['/get-involved', 'src/pages/get-involved.astro'],
    ['/about', 'src/pages/about.astro'],
  ]);
  // EmpowerHer: owner on the home page, new button text equals a route name.
  assert.equal(routeMentionedIn('Change the button text to Get Involved', routes, '/'), null);
  assert.equal(routeMentionedIn('make the heading say get involved today', routes, '/'), null);
  assert.equal(routeMentionedIn('rename it to "Get Involved"', routes, '/'), null);
  assert.equal(routeMentionedIn("the button should read: get-involved", routes, '/'), null);
});

test('routeMentionedIn: a real page mention still wins, including "to the X page"', () => {
  const routes = new Map([
    ['/', 'src/pages/index.astro'],
    ['/get-involved', 'src/pages/get-involved.astro'],
    ['/about', 'src/pages/about.astro'],
  ]);
  assert.equal(routeMentionedIn('on the get involved page change the button text', routes, '/'), '/get-involved');
  assert.equal(routeMentionedIn('move this section to the about page', routes, '/'), '/about');
  assert.equal(routeMentionedIn('get involved: change the first button', routes, '/'), '/get-involved');
});
