import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractCredentials,
  newSessionId,
  SESSION_ENDED_MESSAGE,
  SESSION_ID_ALPHABET,
  SESSION_ID_LENGTH,
  sessionCorsHeaders,
  TERMINAL_SESSION_STATUSES,
} from './request-credentials';

const req = (headers: Record<string, string> = {}, url = 'https://cp.test/api/v1/sessions') =>
  new Request(url, { headers });

test('x-api-key header is the api-key candidate; bearer doubles as edit token', () => {
  const c = extractCredentials(req({ 'x-api-key': 'cp_abc', authorization: 'Bearer tok.sig' }));
  assert.equal(c.apiKeyCandidate, 'cp_abc');
  assert.equal(c.editTokenCandidate, 'tok.sig');
});

test('bearer alone is tried as both credentials', () => {
  const c = extractCredentials(req({ authorization: 'Bearer cp_xyz' }));
  assert.equal(c.apiKeyCandidate, 'cp_xyz');
  assert.equal(c.editTokenCandidate, 'cp_xyz');
});

test('bearer scheme is case-insensitive and the value is trimmed', () => {
  assert.equal(extractCredentials(req({ authorization: 'bearer   abc  ' })).apiKeyCandidate, 'abc');
  assert.equal(extractCredentials(req({ authorization: 'BEARER abc' })).apiKeyCandidate, 'abc');
});

test('non-bearer authorization schemes are ignored', () => {
  const c = extractCredentials(req({ authorization: 'Basic dXNlcjpwdw==' }));
  assert.equal(c.apiKeyCandidate, null);
  assert.equal(c.editTokenCandidate, null);
});

test('?token= feeds only the edit-token candidate (EventSource path)', () => {
  const c = extractCredentials(req({}, 'https://cp.test/api/v1/sessions/x/events?token=qtok'));
  assert.equal(c.apiKeyCandidate, null);
  assert.equal(c.editTokenCandidate, 'qtok');
});

test('bearer wins over ?token= for the edit token', () => {
  const c = extractCredentials(
    req({ authorization: 'Bearer btok' }, 'https://cp.test/x?token=qtok')
  );
  assert.equal(c.editTokenCandidate, 'btok');
});

test('no credentials at all yields nulls', () => {
  assert.deepEqual(extractCredentials(req()), { apiKeyCandidate: null, editTokenCandidate: null });
});

test('CORS headers echo the origin, else wildcard, and always vary on Origin', () => {
  const withOrigin = sessionCorsHeaders('https://hub.example');
  assert.equal(withOrigin['Access-Control-Allow-Origin'], 'https://hub.example');
  assert.equal(withOrigin.Vary, 'Origin');
  assert.match(withOrigin['Access-Control-Allow-Headers'], /Authorization/);
  assert.match(withOrigin['Access-Control-Allow-Headers'], /X-Api-Key/);
  assert.match(withOrigin['Access-Control-Allow-Methods'], /POST/);
  assert.equal(sessionCorsHeaders(null)['Access-Control-Allow-Origin'], '*');
  assert.equal(sessionCorsHeaders('')['Access-Control-Allow-Origin'], '*');
});

test('session ids are DNS-label safe: 12 lowercase alphanumerics, unique', () => {
  assert.equal(SESSION_ID_LENGTH, 12);
  assert.match(SESSION_ID_ALPHABET, /^[a-z0-9]+$/);
  const ids = new Set(Array.from({ length: 200 }, newSessionId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{12}$/);
});

test('terminal statuses are exactly the non-revivable ones', () => {
  // DELIBERATE CHANGE (root-only sites): the needs-config status was removed; a
  // missing site now fails with a plain client-facing error.
  assert.deepEqual(
    [...TERMINAL_SESSION_STATUSES].sort(),
    ['closed', 'expired', 'failed', 'published']
  );
  assert.ok(!(TERMINAL_SESSION_STATUSES as readonly string[]).includes('paused'));
  assert.match(SESSION_ENDED_MESSAGE, /reopen the project/);
});
