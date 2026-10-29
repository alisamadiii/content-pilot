import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { test } from 'node:test';
import { verifyEditToken } from './edit-token';
import { verifyImportToken } from './import-token';

// Scope separation between the edit token ({projectId, exp}) and the one-time
// import token ({projectId, scope:'import', exp}): same secret, same format,
// never interchangeable.

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

test('a valid import token yields its payload', () => {
  assert.deepEqual(
    verifyImportToken(mint({ projectId: P1, scope: 'import', exp: future })),
    { projectId: P1, scope: 'import', exp: future }
  );
});

test('an import token is rejected by verifyEditToken (scope field)', () => {
  const token = mint({ projectId: P1, scope: 'import', exp: future });
  assert.equal(verifyEditToken(token), null);
});

test('an edit token is rejected by verifyImportToken (no scope)', () => {
  const token = mint({ projectId: P1, exp: future });
  assert.equal(verifyImportToken(token), null);
});

test('any scoped payload is rejected by verifyEditToken, import included', () => {
  assert.equal(verifyEditToken(mint({ projectId: P1, scope: 'other', exp: future })), null);
});

test('a wrong scope is rejected by verifyImportToken', () => {
  assert.equal(verifyImportToken(mint({ projectId: P1, scope: 'edit', exp: future })), null);
});

test('expired and tampered import tokens are rejected', () => {
  const past = Math.floor(Date.now() / 1000) - 1;
  assert.equal(verifyImportToken(mint({ projectId: P1, scope: 'import', exp: past })), null);
  assert.equal(
    verifyImportToken(mint({ projectId: P1, scope: 'import', exp: future }, 'other')),
    null
  );
  assert.equal(verifyImportToken(null), null);
  assert.equal(verifyImportToken('a.b.c'), null);
});

test('plain edit tokens still verify after the scope rejection', () => {
  assert.deepEqual(verifyEditToken(mint({ projectId: P1, exp: future })), {
    projectId: P1,
    exp: future,
  });
});
