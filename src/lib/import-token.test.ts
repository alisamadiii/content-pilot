import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { test } from 'node:test';
import { verifyEditToken } from './edit-token';
import { verifyImportToken } from './import-token';

// Scope separation between the edit token ({repoId, exp}) and the one-time
// import token ({repoId, scope:'import', exp}): same secret, same format,
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

test('a valid import token yields its payload', () => {
  assert.deepEqual(
    verifyImportToken(mint({ repoId: 1000000000042, scope: 'import', exp: future })),
    { repoId: 1000000000042, scope: 'import', exp: future }
  );
});

test('an import token is rejected by verifyEditToken (scope field)', () => {
  const token = mint({ repoId: 7, scope: 'import', exp: future });
  assert.equal(verifyEditToken(token), null);
});

test('an edit token is rejected by verifyImportToken (no scope)', () => {
  const token = mint({ repoId: 7, exp: future });
  assert.equal(verifyImportToken(token), null);
});

test('any scoped payload is rejected by verifyEditToken, import included', () => {
  assert.equal(verifyEditToken(mint({ repoId: 7, scope: 'other', exp: future })), null);
});

test('a wrong scope is rejected by verifyImportToken', () => {
  assert.equal(verifyImportToken(mint({ repoId: 7, scope: 'edit', exp: future })), null);
});

test('expired and tampered import tokens are rejected', () => {
  const past = Math.floor(Date.now() / 1000) - 1;
  assert.equal(verifyImportToken(mint({ repoId: 7, scope: 'import', exp: past })), null);
  assert.equal(
    verifyImportToken(mint({ repoId: 7, scope: 'import', exp: future }, 'other')),
    null
  );
  assert.equal(verifyImportToken(null), null);
  assert.equal(verifyImportToken('a.b.c'), null);
});

test('plain edit tokens still verify after the scope rejection', () => {
  assert.deepEqual(verifyEditToken(mint({ repoId: 42, exp: future })), {
    repoId: 42,
    exp: future,
  });
});
