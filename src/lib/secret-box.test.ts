import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { test } from 'node:test';
import { decryptSecret, encryptSecret, MISSING_KEY_MESSAGE } from './secret-box';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

test('round trips text, including unicode and the empty string', () => {
  for (const text of ['{"A":"b"}', 'héllo — ✓', '']) {
    assert.equal(decryptSecret(encryptSecret(text, KEY), KEY), text);
  }
});

test('blobs are versioned and use a fresh iv each time', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.match(a, /^v1:[^:]+:[^:]+:[^:]*$/);
  assert.notEqual(a, b);
});

test('a tampered ciphertext fails to decrypt', () => {
  const [version, iv, tag, ciphertext] = encryptSecret('secret value', KEY).split(':');
  const bytes = Buffer.from(ciphertext, 'base64');
  bytes[0] ^= 1;
  const tampered = [version, iv, tag, bytes.toString('base64')].join(':');
  assert.throws(() => decryptSecret(tampered, KEY));
});

test('the wrong key fails to decrypt', () => {
  assert.throws(() => decryptSecret(encryptSecret('secret', KEY), OTHER_KEY));
});

test('a missing key throws a clear error', () => {
  const saved = process.env.ENV_ENCRYPTION_KEY;
  delete process.env.ENV_ENCRYPTION_KEY;
  try {
    assert.throws(() => encryptSecret('x'), { message: MISSING_KEY_MESSAGE });
    assert.throws(() => decryptSecret('v1:a:b:c'), { message: MISSING_KEY_MESSAGE });
  } finally {
    if (saved !== undefined) process.env.ENV_ENCRYPTION_KEY = saved;
  }
});

test('a key that is not 32 bytes is rejected', () => {
  assert.throws(() => encryptSecret('x', Buffer.from('short').toString('base64')));
});
