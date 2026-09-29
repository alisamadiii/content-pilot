import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractTokens,
  geminiCostUsd,
  interpretGeminiEvent,
  toHubTextDelta,
  toHubToolUse,
} from './run-session-gemini';

// The event shapes below are the REAL Gemini CLI v0.61 stream-json output,
// captured live from `gemini --output-format stream-json` against a client
// repo. Keep them verbatim so a CLI format change trips these tests.

test('init event yields the session id', () => {
  const it = interpretGeminiEvent({
    type: 'init',
    timestamp: '2026-09-29T11:22:41.359Z',
    session_id: 'ed4c27f8-06c8-4118-b939-f690403ae943',
    model: 'gemini-3.1-flash-lite',
  });
  assert.deepEqual(it, {
    kind: 'session',
    sessionId: 'ed4c27f8-06c8-4118-b939-f690403ae943',
  });
});

test('role:user message is skipped (the prompt echo must not render)', () => {
  const it = interpretGeminiEvent({
    type: 'message',
    role: 'user',
    content: 'List the files in this directory.\n',
  });
  assert.deepEqual(it, { kind: 'ignore' });
});

test('assistant message becomes forwarded text', () => {
  const it = interpretGeminiEvent({
    type: 'message',
    role: 'assistant',
    content: 'Astro',
  });
  assert.deepEqual(it, { kind: 'text', text: 'Astro' });
});

test('tool_use maps tool_name + parameters.file_path to Claude shape', () => {
  const it = interpretGeminiEvent({
    type: 'tool_use',
    tool_name: 'read_file',
    tool_id: 'read_file__call_120509',
    parameters: { file_path: '_site.json' },
  });
  assert.deepEqual(it, {
    kind: 'tool',
    name: 'Read',
    input: { file_path: '_site.json' },
  });
});

test('tool_use maps grep/glob names + pattern', () => {
  assert.deepEqual(
    interpretGeminiEvent({
      type: 'tool_use',
      tool_name: 'grep_search',
      parameters: { pattern: 'target:\\s*\\d+' },
    }),
    { kind: 'tool', name: 'Grep', input: { pattern: 'target:\\s*\\d+' } }
  );
  assert.equal(
    interpretGeminiEvent({ type: 'tool_use', tool_name: 'replace' }).kind,
    'tool'
  );
  assert.equal(
    (
      interpretGeminiEvent({ type: 'tool_use', tool_name: 'replace' }) as {
        name: string;
      }
    ).name,
    'Edit'
  );
});

test('unknown tool name passes through unmapped', () => {
  const it = interpretGeminiEvent({ type: 'tool_use', tool_name: 'update_topic' });
  assert.equal((it as { name: string }).name, 'update_topic');
});

test('successful result reads tokens from stats and is not failed', () => {
  const it = interpretGeminiEvent({
    type: 'result',
    status: 'success',
    stats: {
      total_tokens: 25082,
      input_tokens: 25059,
      output_tokens: 23,
      cached: 0,
    },
  });
  assert.deepEqual(it, {
    kind: 'result',
    text: null,
    model: null,
    input: 25059,
    output: 23,
    failed: false, // status:success => not failed
    error: null,
  });
});

test('error result (model-not-found) is marked failed with the message', () => {
  const it = interpretGeminiEvent({
    type: 'result',
    status: 'error',
    error: {
      type: 'unknown',
      message:
        '[API Error: models/gemini-2.5-flash is no longer available to new users.]',
    },
    stats: { input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(it.kind, 'result');
  const result = it as { failed: boolean; error: string | null };
  assert.equal(result.failed, true);
  assert.match(result.error ?? '', /no longer available/);
});

test('result with a non-success status but no error object still fails', () => {
  const it = interpretGeminiEvent({ type: 'result', status: 'cancelled' });
  const result = it as { failed: boolean; error: string | null };
  assert.equal(result.failed, true);
  assert.equal(result.error, 'gemini run cancelled');
});

test('error event carries its message', () => {
  assert.deepEqual(interpretGeminiEvent({ type: 'error', message: 'rate limited' }), {
    kind: 'error',
    message: 'rate limited',
  });
});

test('unrecognized / tool_result events are ignored', () => {
  assert.deepEqual(interpretGeminiEvent({ type: 'tool_result' }), {
    kind: 'ignore',
  });
  assert.deepEqual(interpretGeminiEvent({ type: 'thought' }), { kind: 'ignore' });
  assert.deepEqual(interpretGeminiEvent({}), { kind: 'ignore' });
});

test('extractTokens finds counts nested under stats', () => {
  assert.deepEqual(
    extractTokens({ stats: { input_tokens: 100, output_tokens: 5 } }),
    { input: 100, output: 5 }
  );
  assert.deepEqual(extractTokens({}), { input: null, output: null });
});

test('geminiCostUsd computes from tokens, null when both absent', () => {
  // 200000 in * 0.15/1e6 + 1000 out * 0.6/1e6 = 0.03 + 0.0006
  assert.ok(Math.abs(geminiCostUsd(200000, 1000)! - 0.0306) < 1e-9);
  assert.equal(geminiCostUsd(null, null), null);
  assert.ok(geminiCostUsd(1000, null)! > 0);
});

test('hub mappers emit the exact shapes the reducer folds', () => {
  assert.deepEqual(toHubTextDelta('hi'), {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
  });
  assert.deepEqual(toHubToolUse('Edit', { file_path: 'a.astro' }), {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.astro' } }],
    },
  });
});
