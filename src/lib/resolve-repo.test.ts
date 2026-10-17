import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRemote } from './resolve-repo';

test('https remotes with and without .git / trailing slash', () => {
  assert.deepEqual(parseRemote('https://github.com/acme/site.git'), { owner: 'acme', repo: 'site' });
  assert.deepEqual(parseRemote('https://github.com/acme/site'), { owner: 'acme', repo: 'site' });
  assert.deepEqual(parseRemote('https://github.com/acme/site/'), { owner: 'acme', repo: 'site' });
  assert.deepEqual(parseRemote('https://github.com/acme/site.git/\n'), { owner: 'acme', repo: 'site' });
});

test('ssh remotes', () => {
  assert.deepEqual(parseRemote('git@github.com:acme/site.git'), { owner: 'acme', repo: 'site' });
  assert.deepEqual(parseRemote('ssh://git@github.com/acme/site.git'), { owner: 'acme', repo: 'site' });
});

test('a token-bearing https remote still parses (credentials ignored)', () => {
  assert.deepEqual(parseRemote('https://x-access-token:ghp_abc@github.com/acme/site.git'), {
    owner: 'acme',
    repo: 'site',
  });
});

test('repo names containing dots keep everything but a trailing .git', () => {
  assert.deepEqual(parseRemote('https://github.com/acme/my.site.git'), { owner: 'acme', repo: 'my.site' });
  assert.deepEqual(parseRemote('https://github.com/acme/site.github.io'), { owner: 'acme', repo: 'site.github.io' });
});

test('host is matched case-insensitively', () => {
  assert.deepEqual(parseRemote('https://GitHub.com/acme/site.git'), { owner: 'acme', repo: 'site' });
});

test('non-GitHub or malformed remotes return null', () => {
  assert.equal(parseRemote('https://gitlab.com/acme/site.git'), null);
  assert.equal(parseRemote('https://github.com/acme'), null);
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('not a url'), null);
});
