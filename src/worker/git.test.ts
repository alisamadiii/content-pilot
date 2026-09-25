import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePorcelainLine } from './git';

// Regression: git() trims stdout, so the first porcelain line loses its
// leading status space — a fixed slice(3) then ate the path's first char
// ('_site.json' → 'site.json'), which made the session JSON verify read a
// nonexistent file and revert healthy edits (prod, 2026-09-25).
test('first-line modify with leading space eaten by trim', () => {
  assert.equal(parsePorcelainLine('M _site.json'), '_site.json');
});

test('unstaged modify keeps full path', () => {
  assert.equal(parsePorcelainLine(' M _site.json'), '_site.json');
});

test('untracked file', () => {
  assert.equal(parsePorcelainLine('?? new-file.txt'), 'new-file.txt');
});

test('staged add', () => {
  assert.equal(parsePorcelainLine('A  added.ts'), 'added.ts');
});

test('rename resolves to the new path', () => {
  assert.equal(parsePorcelainLine('R  old.txt -> new.txt'), 'new.txt');
});

// Regression: the denylist saw 'ckage.json' for a first-line package.json
// edit, so the guardrail never matched.
test('first-line package.json reaches the denylist intact', () => {
  assert.equal(parsePorcelainLine('M package.json'), 'package.json');
});

test('quoted path (git core.quotePath) is unquoted', () => {
  assert.equal(parsePorcelainLine(' M "weird name.md"'), 'weird name.md');
});

test('nested path unaffected', () => {
  assert.equal(
    parsePorcelainLine(' M _collections/impact-stories.json'),
    '_collections/impact-stories.json'
  );
});
