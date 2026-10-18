import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFramingOnlyDiff, REFRAME_REPLY } from './reframe-revert';

// Hazara team-grid.astro:34 — the AI replaced a default objectPosition line
// with a per-name ternary. Framing-only → revert.
test('isFramingOnlyDiff: objectPosition JSX replaced (the real Hazara reframe) → true', () => {
  const diff = [
    'diff --git a/src/components/team/team-grid.astro b/...',
    '@@ -31,7 +31,7 @@',
    '-                      objectPosition="center"',
    '+                      objectPosition={member.name === "Saif Azizi" ? "center 20%" : "center"}',
  ].join('\n');
  assert.equal(isFramingOnlyDiff(diff), true);
});

test('isFramingOnlyDiff: a new objectPosition attribute added outright → true', () => {
  const diff = ['@@ -10 +10,2 @@', '+      objectPosition="center 25%"'].join('\n');
  assert.equal(isFramingOnlyDiff(diff), true);
});

test('isFramingOnlyDiff: object-cover ↔ object-contain flip is intentionally NOT caught (left to the prompt rule, avoids shared-line false positives)', () => {
  const diff = [
    '@@ -40 +40 @@',
    '-          class="h-20 w-full object-cover rounded-lg"',
    '+          class="h-20 w-full object-contain rounded-lg"',
  ].join('\n');
  assert.equal(isFramingOnlyDiff(diff), false);
});

test('isFramingOnlyDiff: CSS object-position value change → true', () => {
  const diff = ['@@ -5 +5 @@', '-  object-position: center;', '+  object-position: center 30%;'].join('\n');
  assert.equal(isFramingOnlyDiff(diff), true);
});

test('isFramingOnlyDiff: alt-text change on a line that ALSO has object-cover → false (not a reframe)', () => {
  const diff = [
    '@@ -12 +12 @@',
    '-        <img src="/x.webp" class="object-cover h-20" alt="old" />',
    '+        <img src="/x.webp" class="object-cover h-20" alt="new name" />',
  ].join('\n');
  assert.equal(isFramingOnlyDiff(diff), false);
});

test('isFramingOnlyDiff: an image SWAP (src change) is not framing-only → false', () => {
  const diff = [
    '@@ -3 +3 @@',
    '-    "image_url": "/images/uploads/old.webp",',
    '+    "image_url": "/images/uploads/new.webp",',
  ].join('\n');
  assert.equal(isFramingOnlyDiff(diff), false);
});

test('isFramingOnlyDiff: a size change (height) → false', () => {
  const diff = ['@@ -8 +8 @@', '-        class="h-20 object-cover"', '+        class="h-32 object-cover"'].join('\n');
  assert.equal(isFramingOnlyDiff(diff), false);
});

test('isFramingOnlyDiff: text content change → false; empty diff → false', () => {
  assert.equal(isFramingOnlyDiff('@@ -1 +1 @@\n-<h1>Welcome</h1>\n+<h1>Hello</h1>'), false);
  assert.equal(isFramingOnlyDiff(''), false);
  assert.equal(isFramingOnlyDiff('diff --git a/x b/x\n@@ -0,0 +0,0 @@'), false);
});

test('isFramingOnlyDiff: framing change mixed WITH a text change in the same turn → false', () => {
  const diff = [
    '@@ -31 +31 @@',
    '-                      objectPosition="center"',
    '+                      objectPosition="center 20%"',
    '@@ -50 +50 @@',
    '-            <p>{member.role}</p>',
    '+            <p>{member.role} (Board)</p>',
  ].join('\n');
  assert.equal(isFramingOnlyDiff(diff), false);
});

test('REFRAME_REPLY tells them it cannot see photos and asks for an edited upload', () => {
  assert.match(REFRAME_REPLY, /can't see your photos/);
  assert.match(REFRAME_REPLY, /upload the edited version/);
});
