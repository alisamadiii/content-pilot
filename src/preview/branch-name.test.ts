import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPreviewBranch, isValidBranchName, slugifyBranchName } from './branch-name';

test('isValidBranchName accepts plain slugs and nested names', () => {
  assert.equal(isValidBranchName('new-hero-test'), true);
  assert.equal(isValidBranchName('experiments/summer-sale'), true);
  assert.equal(isValidBranchName('v2'), true);
});

test('isValidBranchName rejects the reserved preview/ prefix', () => {
  assert.equal(isValidBranchName('preview/abc123'), false);
});

test('isValidBranchName rejects git-illegal refs', () => {
  assert.equal(isValidBranchName(''), false);
  assert.equal(isValidBranchName('-leading-dash'), false);
  assert.equal(isValidBranchName('/leading-slash'), false);
  assert.equal(isValidBranchName('.hidden'), false);
  assert.equal(isValidBranchName('trailing/'), false);
  assert.equal(isValidBranchName('trailing.'), false);
  assert.equal(isValidBranchName('name.lock'), false);
  assert.equal(isValidBranchName('a..b'), false);
  assert.equal(isValidBranchName('a//b'), false);
  assert.equal(isValidBranchName('has space'), false);
  assert.equal(isValidBranchName('has~tilde'), false);
  assert.equal(isValidBranchName('has^caret'), false);
  assert.equal(isValidBranchName('has:colon'), false);
  assert.equal(isValidBranchName('has?mark'), false);
  assert.equal(isValidBranchName('has*star'), false);
  assert.equal(isValidBranchName('has[bracket'), false);
  assert.equal(isValidBranchName('has\\backslash'), false);
  assert.equal(isValidBranchName('a@{b'), false);
  assert.equal(isValidBranchName('@'), false);
  assert.equal(isValidBranchName('x'.repeat(101)), false);
});

test('slugifyBranchName lowercases, hyphenates and trims', () => {
  assert.equal(slugifyBranchName('New hero test'), 'new-hero-test');
  assert.equal(slugifyBranchName('  Summer Sale!! 2026 '), 'summer-sale-2026');
  assert.equal(slugifyBranchName('Café Menu'), 'cafe-menu');
  assert.equal(slugifyBranchName('***'), '');
});

test('slugifyBranchName caps at 60 chars without a trailing hyphen', () => {
  const slug = slugifyBranchName(`${'word '.repeat(20)}`);
  assert.ok(slug.length <= 60);
  assert.ok(!slug.endsWith('-'));
  assert.equal(isValidBranchName(slug), true);
});

test('isPreviewBranch only matches the preview/ prefix', () => {
  assert.equal(isPreviewBranch('preview/abc'), true);
  assert.equal(isPreviewBranch('previews'), false);
  assert.equal(isPreviewBranch('main'), false);
});
