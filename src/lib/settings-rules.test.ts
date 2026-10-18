import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appDirKey,
  clampMaxSessions,
  geminiTierKey,
  MAX_SESSIONS_CEILING,
  MAX_SESSIONS_KEY,
  normalizeGeminiTier,
  normalizeProvider,
  providerKey,
  resolveGeminiKey,
  sanitizeAppDir,
} from './settings-rules';

test('setting keys are namespaced per repo', () => {
  assert.equal(appDirKey(1247662764), 'app_dir:1247662764');
  assert.equal(providerKey(1247662764), 'ai_provider:1247662764');
  assert.notEqual(appDirKey(1), providerKey(1));
  assert.equal(MAX_SESSIONS_KEY, 'max_preview_sessions');
});

test('sanitizeAppDir trims and strips surrounding slashes', () => {
  assert.equal(sanitizeAppDir('  marketing/ '), 'marketing');
  assert.equal(sanitizeAppDir('/apps/web/'), 'apps/web');
  assert.equal(sanitizeAppDir('///x///'), 'x');
  assert.equal(sanitizeAppDir('apps/web/site'), 'apps/web/site');
});

test('sanitizeAppDir treats empty / unset as auto (null)', () => {
  assert.equal(sanitizeAppDir(''), null);
  assert.equal(sanitizeAppDir('   '), null);
  assert.equal(sanitizeAppDir('/'), null);
  assert.equal(sanitizeAppDir(null), null);
  assert.equal(sanitizeAppDir(undefined), null);
});

test('sanitizeAppDir rejects traversal anywhere in the path', () => {
  for (const bad of ['..', '../x', 'x/..', 'x/../y', '/..']) {
    assert.throws(() => sanitizeAppDir(bad), /inside the repo/, bad);
  }
});

test('sanitizeAppDir keeps folders whose names merely contain dots', () => {
  assert.equal(sanitizeAppDir('..x'), '..x');
  assert.equal(sanitizeAppDir('site.v2/app'), 'site.v2/app');
  assert.equal(sanitizeAppDir('.hidden'), '.hidden');
});

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

// ------------------------------------------------- gemini key tier (2026-10-18)

test('geminiTierKey is namespaced per repo and distinct from the other keys', () => {
  assert.equal(geminiTierKey(1247662764), 'gemini_tier:1247662764');
  assert.notEqual(geminiTierKey(1), providerKey(1));
  assert.notEqual(geminiTierKey(1), appDirKey(1));
});

test('normalizeGeminiTier: only an explicit "paid" selects paid; everything else is free', () => {
  assert.equal(normalizeGeminiTier('paid'), 'paid');
  assert.equal(normalizeGeminiTier('  PAID '), 'paid');
  assert.equal(normalizeGeminiTier('Paid'), 'paid');
  assert.equal(normalizeGeminiTier('free'), 'free');
  assert.equal(normalizeGeminiTier(''), 'free');
  assert.equal(normalizeGeminiTier(null), 'free');
  assert.equal(normalizeGeminiTier(undefined), 'free');
  assert.equal(normalizeGeminiTier('premium'), 'free');
});

test('resolveGeminiKey: paid tier with a paid key uses the paid key', () => {
  assert.deepEqual(
    resolveGeminiKey({ tier: 'paid', freeKey: 'FREE', paidKey: 'PAID' }),
    { key: 'PAID', tier: 'paid' }
  );
});

test('resolveGeminiKey: paid tier with no paid key falls back to the free key (never a hard failure)', () => {
  assert.deepEqual(
    resolveGeminiKey({ tier: 'paid', freeKey: 'FREE', paidKey: '' }),
    { key: 'FREE', tier: 'free' }
  );
});

test('resolveGeminiKey: free tier always uses the free key, even when a paid key exists', () => {
  assert.deepEqual(
    resolveGeminiKey({ tier: 'free', freeKey: 'FREE', paidKey: 'PAID' }),
    { key: 'FREE', tier: 'free' }
  );
});
