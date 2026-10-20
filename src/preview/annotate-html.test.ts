import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annotateHtmlSource } from '../../ai-analyzer/annotate-html.mjs';

// The plain-HTML data-cms-src tagger behind static-repo click-to-edit
// (ai-analyzer/vite-plugin-static.mjs). Ref format must stay in lockstep with
// parseSourceRef (prompt-context.ts): `<project?>:<file>:<line>`.

const tag = (source: string) =>
  annotateHtmlSource(source, { project: '', srcPath: 'index.html' }) as
    | string
    | null;

test('stamps file:line on plain elements, multi-line', () => {
  const out = tag('<main>\n  <h1>Hello</h1>\n  <img src="/a.png">\n</main>\n');
  assert.equal(
    out,
    '<main data-cms-src="index.html:1">\n  <h1 data-cms-src="index.html:2">Hello</h1>\n  <img src="/a.png" data-cms-src="index.html:3">\n</main>\n'
  );
});

test('skips structural/meta tags (html, head, body, meta, link, title, script, style)', () => {
  const out = tag(
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>T</title>\n<link rel="stylesheet" href="s.css">\n</head>\n<body>\n<p>hi</p>\n</body>\n</html>\n'
  );
  assert.ok(out);
  assert.equal((out!.match(/data-cms-src/g) ?? []).length, 1);
  assert.ok(out!.includes('<p data-cms-src="index.html:9">hi</p>'));
});

test('script and style BODIES are raw text — tag-shaped strings inside stay untouched', () => {
  const out = tag(
    '<div>a</div>\n<script>const s = "<div>fake</div>";</script>\n<style>.x{content:"<p>"}</style>\n<span>b</span>\n'
  );
  assert.equal(
    out,
    '<div data-cms-src="index.html:1">a</div>\n<script>const s = "<div>fake</div>";</script>\n<style>.x{content:"<p>"}</style>\n<span data-cms-src="index.html:4">b</span>\n'
  );
});

test('textarea body is escapable raw text — not tagged, not parsed', () => {
  const out = tag('<textarea>\n<div>not markup</div>\n</textarea>\n<p>x</p>\n');
  assert.equal(
    out,
    '<textarea data-cms-src="index.html:1">\n<div>not markup</div>\n</textarea>\n<p data-cms-src="index.html:4">x</p>\n'
  );
});

test('comments are skipped, including commented-out markup', () => {
  const out = tag('<!-- <div>old</div> -->\n<div>new</div>\n');
  assert.equal(out, '<!-- <div>old</div> -->\n<div data-cms-src="index.html:2">new</div>\n');
});

test('`>` inside quoted attribute values does not end the tag', () => {
  const out = tag('<a href="/x" title="a > b" data-arrow=\'->\'>link</a>\n');
  assert.equal(
    out,
    '<a href="/x" title="a > b" data-arrow=\'->\' data-cms-src="index.html:1">link</a>\n'
  );
});

test('self-closing tags get the attribute before the slash', () => {
  const out = tag('<section>\n  <img src="a.png" />\n</section>\n');
  assert.equal(
    out,
    '<section data-cms-src="index.html:1">\n  <img src="a.png" data-cms-src="index.html:2" />\n</section>\n'
  );
});

test('idempotent: already-tagged elements are left alone', () => {
  const once = tag('<div>\n<p>hi</p>\n</div>\n')!;
  assert.equal(annotateHtmlSource(once, { project: '', srcPath: 'index.html' }), null);
});

test('returns null when there is nothing to tag', () => {
  assert.equal(tag('<!DOCTYPE html>\n<!-- only structure -->\n'), null);
});

test('project prefix lands in the ref, matching parseSourceRef', () => {
  const out = annotateHtmlSource('<h2>t</h2>', {
    project: 'acme',
    srcPath: 'about.html',
  });
  assert.equal(out, '<h2 data-cms-src="acme:about.html:1">t</h2>');
});

test('custom elements and hyphenated tags are tagged', () => {
  const out = tag('<my-widget size="2">x</my-widget>');
  assert.equal(
    out,
    '<my-widget size="2" data-cms-src="index.html:1">x</my-widget>'
  );
});

test('unterminated final tag does not crash or loop', () => {
  assert.equal(tag('<p>ok</p>\n<div class="broken'), '<p data-cms-src="index.html:1">ok</p>\n<div class="broken');
});
