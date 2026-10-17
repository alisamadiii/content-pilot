import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repoColor, repoHue } from './repo-color';

test('repoHue is deterministic and within 0..359', () => {
  assert.equal(repoHue('acme/site'), repoHue('acme/site'));
  for (const key of ['', 'a', 'acme/site', 'x'.repeat(500)]) {
    const h = repoHue(key);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `${key.length}: ${h}`);
  }
});

test('different repos (even same owner) get different hues', () => {
  assert.notEqual(repoHue('acme/site'), repoHue('acme/blog'));
  assert.notEqual(repoHue('acme/site'), repoHue('other/site'));
});

test('repoColor formats an hsl() string from owner/repo', () => {
  assert.equal(repoColor('acme', 'site'), `hsl(${repoHue('acme/site')} 65% 50%)`);
  assert.match(repoColor('acme', 'site'), /^hsl\(\d{1,3} 65% 50%\)$/);
});
