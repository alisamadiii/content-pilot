import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  domainKey,
  normalizeHost,
  previewBaseHost,
  slugHost,
  validateCustomHost,
  validateSlug,
} from './domain-rules';

// ---------------------------------------------------------------- normalize

test('normalizeHost lowercases, strips port and trailing dot', () => {
  assert.equal(normalizeHost('WWW.Client.COM'), 'www.client.com');
  assert.equal(normalizeHost('www.client.com:8080'), 'www.client.com');
  assert.equal(normalizeHost('www.client.com.'), 'www.client.com');
  assert.equal(normalizeHost('  www.client.com  '), 'www.client.com');
});

test('normalizeHost punycodes unicode hostnames', () => {
  assert.equal(normalizeHost('www.münchen.de'), 'www.xn--mnchen-3ya.de');
});

test('normalizeHost returns empty string on garbage', () => {
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost('   '), '');
});

// ---------------------------------------------------------------- slugs

test('validateSlug accepts clean slugs and lowercases', () => {
  assert.equal(validateSlug('acme'), 'acme');
  assert.equal(validateSlug('My-Shop'), 'my-shop');
  assert.equal(validateSlug('a1b'), 'a1b');
});

test('validateSlug enforces length bounds', () => {
  assert.throws(() => validateSlug('ab'), /3 to 63/);
  assert.throws(() => validateSlug('a'.repeat(64)), /3 to 63/);
  assert.equal(validateSlug('a'.repeat(63)), 'a'.repeat(63));
});

test('validateSlug rejects bad charset and hyphen edges', () => {
  assert.throws(() => validateSlug('my_site'), /lowercase letters/);
  assert.throws(() => validateSlug('-abc'), /lowercase letters/);
  assert.throws(() => validateSlug('abc-'), /lowercase letters/);
  assert.throws(() => validateSlug('a.b.c'), /lowercase letters/);
});

test('validateSlug rejects the site-<id> live-label namespace', () => {
  assert.throws(() => validateSlug('site-123'), /reserved/);
  assert.throws(() => validateSlug('site-1000000000123'), /reserved/);
});

test('validateSlug rejects the 12-char session-id label shape', () => {
  assert.throws(() => validateSlug('abc123def456'), /hyphen/);
  // 12 chars WITH a hyphen is fine (not a session-id shape).
  assert.equal(validateSlug('abc123-ef456'), 'abc123-ef456');
  // 11 and 13 plain alnum are fine.
  assert.equal(validateSlug('abc123def45'), 'abc123def45');
  assert.equal(validateSlug('abc123def4567'), 'abc123def4567');
});

test('validateSlug rejects reserved names', () => {
  for (const name of ['www', 'pilot', 'api', 'mail', 'admin', 'fallback']) {
    assert.throws(() => validateSlug(name), /reserved/);
  }
});

// ---------------------------------------------------------------- custom hosts

const OWN = { ownHosts: ['alisamadii.dev', 'pilot.alisamadii.com', 'alisamadii.com'] };

test('validateCustomHost accepts a www subdomain', () => {
  assert.equal(validateCustomHost('www.client.com', OWN), 'www.client.com');
  assert.equal(validateCustomHost('Shop.Client.COM', OWN), 'shop.client.com');
});

test('validateCustomHost rejects apex domains with the registrar hint', () => {
  assert.throws(() => validateCustomHost('client.com', OWN), /Root domains/);
});

test('validateCustomHost rejects IPs and localhost', () => {
  assert.throws(() => validateCustomHost('1.2.3.4', OWN), /IP address/);
  assert.throws(() => validateCustomHost('localhost', OWN), /valid domain/);
  assert.throws(() => validateCustomHost('a.b.localhost', OWN), /valid domain/);
});

test('validateCustomHost rejects our own hosts and their subdomains', () => {
  assert.throws(() => validateCustomHost('x.y.alisamadii.dev', OWN), /not available/);
  assert.throws(() => validateCustomHost('pilot.alisamadii.com', OWN), /not available/);
  assert.throws(() => validateCustomHost('a.alisamadii.com', OWN), /not available/);
});

test('validateCustomHost rejects malformed hosts', () => {
  assert.throws(() => validateCustomHost('', OWN), /valid domain/);
  assert.throws(() => validateCustomHost('a..b.com', OWN), /valid domain/);
  assert.throws(() => validateCustomHost(`${'a'.repeat(64)}.b.com`, OWN), /valid domain/);
});

// ---------------------------------------------------------------- base host

test('previewBaseHost derives the wildcard base from the url base', () => {
  assert.equal(previewBaseHost('https://{id}.alisamadii.dev'), 'alisamadii.dev');
  assert.equal(previewBaseHost('http://{id}.localhost:3020'), 'localhost');
  assert.equal(previewBaseHost('not a url'), '');
});

test('slugHost composes the mapped host', () => {
  assert.equal(slugHost('acme', 'https://{id}.alisamadii.dev'), 'acme.alisamadii.dev');
  assert.equal(slugHost('acme', 'http://{id}.localhost:3020'), 'acme.localhost');
});

test('domainKey shape', () => {
  assert.equal(domainKey('www.client.com'), 'domain:www.client.com');
});
