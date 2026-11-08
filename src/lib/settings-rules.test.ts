import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampMaxSessions,
  MAX_SESSIONS_CEILING,
  MAX_SESSIONS_KEY,
  normalizeProvider,
  providerKey,
} from './settings-rules';

// DELIBERATE CHANGE (root-only sites): app-folder override removed (its key
// assertions dropped from this test).
// DELIBERATE CHANGE (2026-10-29): keys are per hub projectId (uuid).
test('setting keys are namespaced per project', () => {
  assert.equal(providerKey('11111111-1111-4111-8111-111111111111'), 'ai_provider:11111111-1111-4111-8111-111111111111');
  assert.equal(MAX_SESSIONS_KEY, 'max_preview_sessions');
});

// DELIBERATE CHANGE (root-only sites): app-folder override removed.
// Its path-sanitizer tests went with it.

test('normalizeProvider: only "claude" (any case, trimmed) selects claude', () => {
  assert.equal(normalizeProvider('claude'), 'claude');
  assert.equal(normalizeProvider('  Claude '), 'claude');
  assert.equal(normalizeProvider('CLAUDE'), 'claude');
  assert.equal(normalizeProvider('gemini'), 'gemini');
  assert.equal(normalizeProvider('claude-3'), 'gemini');
  assert.equal(normalizeProvider('anthropic'), 'gemini');
  assert.equal(normalizeProvider(''), 'gemini');
  assert.equal(normalizeProvider(null), 'gemini');
  assert.equal(normalizeProvider(undefined), 'gemini');
});

test('clampMaxSessions uses a valid stored override', () => {
  assert.equal(clampMaxSessions('5', 3), 5);
  assert.equal(clampMaxSessions('1', 3), 1);
  assert.equal(clampMaxSessions(' 7 ', 3), 7);
});

test('clampMaxSessions falls back for unset or invalid values', () => {
  assert.equal(clampMaxSessions(null, 3), 3);
  assert.equal(clampMaxSessions(undefined, 3), 3);
  assert.equal(clampMaxSessions('', 3), 3);
  assert.equal(clampMaxSessions('abc', 3), 3);
  assert.equal(clampMaxSessions('0', 3), 3);
  assert.equal(clampMaxSessions('-2', 3), 3);
  assert.equal(clampMaxSessions('2.5', 3), 2); // parseInt
});

test('clampMaxSessions clamps both the override and the fallback into 1..ceiling', () => {
  assert.equal(MAX_SESSIONS_CEILING, 20);
  assert.equal(clampMaxSessions('999', 3), 20);
  assert.equal(clampMaxSessions('20', 3), 20);
  assert.equal(clampMaxSessions('21', 3), 20);
  assert.equal(clampMaxSessions(null, 0), 1);
  assert.equal(clampMaxSessions(null, 50), 20);
});
