import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsSsl } from './ssl';

const NEON = 'postgres://u:p@ep-abc.aws.neon.tech/db';
const DOCKER = 'postgres://u:p@db:5432/db';
const LOOPBACK = 'postgres://u:p@127.0.0.1:5433/db';

test('managed hosts with a dotted domain require TLS', () => {
  assert.equal(needsSsl(NEON, undefined), true);
});

test('single-label docker hosts and 127.0.0.1 speak plaintext', () => {
  assert.equal(needsSsl(DOCKER, undefined), false);
  assert.equal(needsSsl(LOOPBACK, undefined), false);
  assert.equal(needsSsl('postgres://u:p@localhost:5433/db', undefined), false);
});

test('DATABASE_SSL override beats everything, case-insensitively', () => {
  assert.equal(needsSsl(DOCKER, 'require'), true);
  assert.equal(needsSsl(DOCKER, 'TRUE'), true);
  assert.equal(needsSsl(NEON, 'disable'), false);
  assert.equal(needsSsl(NEON, 'False'), false);
});

test('an unrecognized override is ignored and the URL decides', () => {
  assert.equal(needsSsl(NEON, 'maybe'), true);
  assert.equal(needsSsl(DOCKER, ''), false);
});

test('sslmode in the URL beats the host heuristic', () => {
  assert.equal(needsSsl(`${DOCKER}?sslmode=require`, undefined), true);
  assert.equal(needsSsl(`${NEON}?sslmode=disable`, undefined), false);
  assert.equal(needsSsl(`${NEON}?x=1&sslmode=disable`, undefined), false);
});

test('an unparseable connection string defaults to plaintext', () => {
  assert.equal(needsSsl('not a url', undefined), false);
  assert.equal(needsSsl('', undefined), false);
});
