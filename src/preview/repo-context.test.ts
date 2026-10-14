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
  const ctx = await buildRepoContext(dir, dir);
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
  assert.equal((await buildRepoContext(dir, dir)).agentNotes, '');
  assert.doesNotMatch((await buildRepoContext(dir, dir)).text, /Developer notes/);
  await writeFile(join(dir, 'CLAUDE.md'), 'Only claude notes');
  assert.equal((await buildRepoContext(dir, dir)).agentNotes, 'Only claude notes');
});

test('buildRepoContext prefixes paths for a subfolder app', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-repo-'));
  await mkdir(join(dir, 'site/src/pages'), { recursive: true });
  await writeFile(join(dir, 'site/package.json'), '{"dependencies":{"astro":"^5"}}');
  await writeFile(join(dir, 'site/src/pages/index.astro'), '<h1/>');
  const ctx = await buildRepoContext(dir, join(dir, 'site'));
  assert.equal(ctx.routes.get('/'), 'site/src/pages/index.astro');
  assert.equal(ctx.publicRel, 'site/public');
});

test('buildRepoContext handles Next app + pages routers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cp-repo-'));
  const files: Record<string, string> = {
    'package.json': '{"dependencies":{"next":"15"}}',
    'app/page.tsx': '',
    'app/(marketing)/about/page.tsx': '',
    'app/blog/[slug]/page.tsx': '',
    'app/layout.tsx': '',
    'pages/contact.tsx': '',
    'pages/_app.tsx': '',
    'pages/api/x.ts': '',
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, rel, '..'), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  const ctx = await buildRepoContext(dir, dir);
  assert.equal(ctx.framework, 'next');
  assert.equal(ctx.routes.get('/'), 'app/page.tsx');
  assert.equal(ctx.routes.get('/about'), 'app/(marketing)/about/page.tsx');
  assert.equal(ctx.routes.get('/blog/[slug]'), 'app/blog/[slug]/page.tsx');
  assert.equal(ctx.routes.get('/contact'), 'pages/contact.tsx');
  assert.equal(ctx.routes.has('/_app'), false);
  assert.equal(ctx.routes.has('/api/x'), false);
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
  const bundle = await collectPageBundle(dir, dir, 'src/pages/about.astro', 40_000);
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
  const tight = await collectPageBundle(dir, dir, 'src/pages/about.astro', pageLength + 5);
  assert.ok(tight);
  assert.deepEqual(tight.files.map((f) => f.path), ['src/pages/about.astro']);
  assert.deepEqual(tight.omitted, ['src/components/about/story.astro']);
  assert.equal(await collectPageBundle(dir, dir, 'src/pages/about.astro', 10), null);
  assert.equal(await collectPageBundle(dir, dir, 'src/pages/nope.astro', 1000), null);
});
