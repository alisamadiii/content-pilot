import assert from 'node:assert/strict';
import { test } from 'node:test';

// Env is read once at import, so set it before the (dynamic) import.
process.env.PREVIEW_URL_BASE = 'https://{id}.preview.example.com';
process.env.PREVIEW_PORT_MIN = 'abc';
process.env.PREVIEW_PORT_MAX = '0';
process.env.MAX_PREVIEW_SESSIONS = '7';
process.env.SESSION_GEMINI_IN_PRICE = '0.2';
process.env.SESSION_CLAUDE_MODEL = '';
// .env may set these; pin to empty so the code defaults are what we test.
process.env.SESSION_IDLE_MINUTES = '';
process.env.SESSION_IDLE_WARN_MINUTES = '';
process.env.SESSION_GEMINI_MODEL = '';

test('previewUrlFor substitutes the session id into the base', async () => {
  const { previewUrlFor } = await import('./config');
  assert.equal(previewUrlFor('abc123'), 'https://abc123.preview.example.com');
});

test('numeric env values: valid overrides win, NaN and 0 fall back to defaults', async () => {
  const { previewConfig } = await import('./config');
  assert.equal(previewConfig.maxSessions, 7);
  assert.equal(previewConfig.portMin, 4100);
  assert.equal(previewConfig.portMax, 4109);
  assert.equal(previewConfig.geminiInPricePerM, 0.2);
  assert.equal(previewConfig.geminiOutPricePerM, 0.6);
});

test('empty string model env falls back to the default model', async () => {
  const { previewConfig } = await import('./config');
  assert.equal(previewConfig.claudeModel, 'haiku');
  assert.equal(previewConfig.geminiModel, 'gemini-3.1-flash-lite');
});

test('idle warning fires before the idle kill by default', async () => {
  const { previewConfig } = await import('./config');
  assert.equal(previewConfig.idleMinutes, 30);
  assert.equal(previewConfig.idleWarnMinutes, 20);
  assert.ok(previewConfig.idleWarnMinutes < previewConfig.idleMinutes);
});
