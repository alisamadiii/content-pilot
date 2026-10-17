import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annotateAstroSource,
  annotateWithLegacyAst,
  annotateWithRsAst,
} from '../../ai-analyzer/annotate.mjs';

// Minimal @astrojs/compiler-rs-shaped AST builder. The real parser emits
// ESTree/JSX nodes with UTF-16 char offsets and no line numbers; these helpers
// derive offsets from the source so the fixtures can't drift from the markup.
type RsNode = Record<string, unknown>;

const opening = (src: string, tag: string, nth = 0): RsNode => {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  let m: RegExpExecArray | null = null;
  for (let i = 0; i <= nth; i++) m = re.exec(src);
  if (!m) throw new Error(`no <${tag}> #${nth} in fixture`);
  const start = m.index;
  const end = src.indexOf('>', start) + 1;
  const member = tag.includes('.');
  return {
    type: 'JSXOpeningElement',
    name: member
      ? { type: 'JSXMemberExpression', start, end }
      : { type: 'JSXIdentifier', name: tag, start: start + 1, end: start + 1 + tag.length },
    attributes: [],
    start,
    end,
  };
};

const el = (src: string, tag: string, children: RsNode[] = [], nth = 0): RsNode => ({
  type: 'JSXElement',
  openingElement: opening(src, tag, nth),
  closingElement: null,
  children,
  start: 0,
  end: src.length,
});

const root = (...children: RsNode[]): RsNode => ({
  type: 'AstroRoot',
  frontmatter: { type: 'AstroFrontmatter', program: { type: 'Program', body: [] } },
  children,
  start: 0,
  end: 0,
});

const opts = { project: '', srcPath: 'src/x.astro' };

test('rs: plain element gets data-cms-src with the right line', () => {
  const src = '---\n---\n<p class="a">hi</p>\n';
  const out = annotateWithRsAst(src, root(el(src, 'p')), opts);
  assert.equal(out, '---\n---\n<p class="a" data-cms-src="src/x.astro:3">hi</p>\n');
});

test('rs: self-closing tag is annotated before the />', () => {
  const src = '<img src="/a.png" />';
  const out = annotateWithRsAst(src, root(el(src, 'img')), opts);
  assert.equal(out, '<img src="/a.png" data-cms-src="src/x.astro:1" />');
});

test('rs: components, member components and Fragment are left alone', () => {
  const src = '<Header /><Foo.Bar /><Fragment><p>x</p></Fragment>';
  const ast = root(
    el(src, 'Header'),
    el(src, 'Foo.Bar'),
    el(src, 'Fragment', [el(src, 'p')])
  );
  const out = annotateWithRsAst(src, ast, opts);
  assert.equal(
    out,
    '<Header /><Foo.Bar /><Fragment><p data-cms-src="src/x.astro:1">x</p></Fragment>'
  );
});

test('rs: structural/skip tags are untouched', () => {
  const src = '<html><head><title>t</title><script>s</script></head><body><slot /><div>x</div></body></html>';
  const ast = root(
    el(src, 'html', [
      el(src, 'head', [el(src, 'title'), el(src, 'script')]),
      el(src, 'body', [el(src, 'slot'), el(src, 'div')]),
    ])
  );
  const out = annotateWithRsAst(src, ast, opts);
  assert.equal(
    out,
    '<html><head><title>t</title><script>s</script></head><body><slot /><div data-cms-src="src/x.astro:1">x</div></body></html>'
  );
});

test('rs: non-ASCII text before an element does not shift the splice (char offsets)', () => {
  const src = '<p>a — b · c</p>\n<span>x</span>';
  const out = annotateWithRsAst(src, root(el(src, 'p'), el(src, 'span')), opts);
  assert.equal(
    out,
    '<p data-cms-src="src/x.astro:1">a — b · c</p>\n<span data-cms-src="src/x.astro:2">x</span>'
  );
});

test('rs: elements inside expression bodies ({list.map(() => <li/>)}) are tagged', () => {
  const src = '<ul>\n{items.map((i) => <li>{i}</li>)}\n</ul>';
  const ast = root(
    el(src, 'ul', [
      {
        type: 'JSXExpressionContainer',
        expression: {
          type: 'CallExpression',
          arguments: [{ type: 'ArrowFunctionExpression', body: el(src, 'li') }],
        },
      },
    ])
  );
  const out = annotateWithRsAst(src, ast, opts);
  assert.equal(
    out,
    '<ul data-cms-src="src/x.astro:1">\n{items.map((i) => <li data-cms-src="src/x.astro:2">{i}</li>)}\n</ul>'
  );
});

test('rs: project prefix is included', () => {
  const src = '<p>x</p>';
  const out = annotateWithRsAst(src, root(el(src, 'p')), { project: 'site', srcPath: 'a.astro' });
  assert.equal(out, '<p data-cms-src="site:a.astro:1">x</p>');
});

test('rs: nothing to annotate returns null', () => {
  const src = '<Header />';
  assert.equal(annotateWithRsAst(src, root(el(src, 'Header')), opts), null);
});

test('legacy: element AST with byte offsets still annotates', () => {
  const src = '<p>a — b</p>';
  const buf = Buffer.from(src);
  const ast = {
    type: 'root',
    children: [
      {
        type: 'element',
        name: 'p',
        position: { start: { offset: 0, line: 1 } },
        children: [],
      },
    ],
  };
  assert.equal(buf.indexOf('<p>'), 0);
  const out = annotateWithLegacyAst(src, ast, opts);
  assert.equal(out, '<p data-cms-src="src/x.astro:1">a — b</p>');
});

test('annotateAstroSource dispatches on the injected parser kind', async () => {
  const src = '<p>x</p>';
  const rs = await annotateAstroSource(src, opts, {
    kind: 'rs',
    parse: () => ({ ast: root(el(src, 'p')), diagnostics: [] }),
  });
  assert.equal(rs, '<p data-cms-src="src/x.astro:1">x</p>');
  const legacy = await annotateAstroSource(src, opts, {
    kind: 'legacy',
    parse: async () => ({
      ast: {
        type: 'root',
        children: [
          { type: 'element', name: 'p', position: { start: { offset: 0, line: 1 } }, children: [] },
        ],
      },
    }),
  });
  assert.equal(legacy, '<p data-cms-src="src/x.astro:1">x</p>');
});
