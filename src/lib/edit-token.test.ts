import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { test } from 'node:test';
import { verifyEditToken } from './edit-token';

const SECRET = 'test-secret';
process.env.EDIT_TOKEN_SECRET = SECRET;

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const mint = (payload: unknown, secret = SECRET) => {
  const body = b64(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
};
const future = Math.floor(Date.now() / 1000) + 600;
// DELIBERATE CHANGE (2026-10-29 projectId switch): tokens are scoped by the
// hub projectId (uuid) instead of the old numeric repo id.
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';

test('a valid, unexpired token yields its payload', () => {
  assert.deepEqual(verifyEditToken(mint({ projectId: P1, exp: future })), {
    projectId: P1,
    exp: future,
  });
});

test('an expired token is rejected (exp in the past or exactly now)', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyEditToken(mint({ projectId: P1, exp: now - 1 })), null);
  assert.equal(verifyEditToken(mint({ projectId: P1, exp: now })), null);
});

test('a token signed with another secret is rejected', () => {
  assert.equal(verifyEditToken(mint({ projectId: P1, exp: future }, 'other')), null);
});

test('tampering with the body invalidates the signature', () => {
  const good = mint({ projectId: P1, exp: future });
  const [, sig] = good.split('.');
  const tampered = `${b64(JSON.stringify({ projectId: P2, exp: future }))}.${sig}`;
  assert.equal(verifyEditToken(tampered), null);
});

test('malformed shapes are rejected without throwing', () => {
  assert.equal(verifyEditToken(null), null);
  assert.equal(verifyEditToken(''), null);
  assert.equal(verifyEditToken('abc'), null);
  assert.equal(verifyEditToken('a.b.c'), null);
  assert.equal(verifyEditToken(`${mint({ projectId: P1, exp: future })}.extra`), null);
  assert.equal(verifyEditToken('a.'), null);
  const body = b64('not json');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  assert.equal(verifyEditToken(`${body}.${sig}`), null);
});

test('payload must carry a uuid projectId and numeric exp', () => {
  assert.equal(verifyEditToken(mint({ projectId: 42, exp: future })), null);
  assert.equal(verifyEditToken(mint({ projectId: 'not-a-uuid', exp: future })), null);
  assert.equal(verifyEditToken(mint({ projectId: P1, exp: String(future) })), null);
  assert.equal(verifyEditToken(mint({ exp: future })), null);
  assert.equal(verifyEditToken(mint(null)), null);
});

test('a signature of the wrong length is rejected before comparison', () => {
  const body = b64(JSON.stringify({ projectId: P1, exp: future }));
  assert.equal(verifyEditToken(`${body}.${b64('short')}`), null);
});

test('no EDIT_TOKEN_SECRET configured means every token is rejected', () => {
  const token = mint({ projectId: P1, exp: future });
  delete process.env.EDIT_TOKEN_SECRET;
  try {
    assert.equal(verifyEditToken(token), null);
  } finally {
    process.env.EDIT_TOKEN_SECRET = SECRET;
  }
});
