import assert from 'node:assert/strict';
import { test } from 'node:test';
// The JSX tagger lives in the copy-into-clone analyzer folder (plain ESM). These
// tests guard the DOM-mapping contract the overlay + prompt-context depend on:
// intrinsic elements get data-cms-src at their real source line, components and
// non-visual tags never do.
import { annotateJsxSource } from '../../ai-analyzer/annotate-jsx.mjs';

const SRC = `export function Hero() {
  return (
    <section className="hero">
      <h1>Welcome</h1>
      <Button label="x" />
      <motion.div>anim</motion.div>
      <p>copy</p>
      <img src="/a.png" alt="a" />
    </section>
  );
}
`;

const refs = (out: string): string[] =>
  [...out.matchAll(/data-cms-src="([^"]*)"/g)].map((m) => m[1]);

test('intrinsic elements are tagged with their real source line', () => {
  const out = annotateJsxSource(SRC, { srcPath: 'src/Hero.tsx', project: '' });
  const got = refs(out);
  assert.ok(got.includes('src/Hero.tsx:3'), 'section on line 3');
  assert.ok(got.includes('src/Hero.tsx:4'), 'h1 on line 4');
  assert.ok(got.includes('src/Hero.tsx:7'), 'p on line 7');
  assert.ok(got.includes('src/Hero.tsx:8'), 'img on line 8');
});

test('capitalized components are not tagged (props may not reach the DOM)', () => {
  const out = annotateJsxSource(SRC, { srcPath: 'src/Hero.tsx', project: '' });
  assert.ok(!/<Button[^>]*data-cms-src/.test(out));
});

test('member elements (motion.div) are not tagged', () => {
  const out = annotateJsxSource(SRC, { srcPath: 'src/Hero.tsx', project: '' });
  assert.ok(!/<motion\.div[^>]*data-cms-src/.test(out));
});

test('SKIP_TAGS (script/style/head/...) are never tagged', () => {
  const src = `export const A = () => (<div><script>{"x"}</script><style>{"y"}</style></div>);`;
  const out = annotateJsxSource(src, { srcPath: 'a.tsx', project: '' });
  assert.ok(/<div data-cms-src/.test(out), 'div tagged');
  assert.ok(!/<script data-cms-src/.test(out), 'script skipped');
  assert.ok(!/<style data-cms-src/.test(out), 'style skipped');
});

test('project prefix is included when provided', () => {
  const out = annotateJsxSource('export const A = () => <p>hi</p>;', {
    srcPath: 'a.tsx',
    project: 'acme',
  });
  assert.ok(refs(out).includes('acme:a.tsx:1'));
});

test('an already-tagged element keeps its ref; only fresh siblings get tagged', () => {
  const src = `export const A = () => (<div><p data-cms-src="x:1">a</p><span>b</span></div>);`;
  const out = annotateJsxSource(src, { srcPath: 'a.tsx', project: '' });
  const got = refs(out);
  // the pre-tagged <p> keeps exactly its original ref (not re-stamped)
  assert.equal(got.filter((r) => r === 'x:1').length, 1);
  // div and span are freshly tagged
  assert.ok(got.some((r) => r === 'a.tsx:1'));
  assert.equal(got.length, 3);
});

test('a source whose only element is already tagged needs no change (null)', () => {
  const src = `export const A = () => <p data-cms-src="x:1">hi</p>;`;
  const out = annotateJsxSource(src, { srcPath: 'a.tsx', project: '' });
  assert.equal(out, null);
});

test('source with no taggable elements returns null', () => {
  const out = annotateJsxSource('export const n = 1;', {
    srcPath: 'a.tsx',
    project: '',
  });
  assert.equal(out, null);
});

test('unparseable source fails open (returns null, never throws)', () => {
  const out = annotateJsxSource('export const = = = <<<', {
    srcPath: 'a.tsx',
    project: '',
  });
  assert.equal(out, null);
});
