import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRecap, sanitizeForClient } from './recap';

test('empty history renders no recap', () => {
  assert.equal(renderRecap([]), null);
});

test('recap labels roles and wraps with recovery framing', () => {
  const recap = renderRecap([
    { role: 'user', content: 'Make the hero blue', status: 'done', error: null },
    { role: 'assistant', content: 'Done! Hero is blue.', status: 'done', error: null },
  ]);
  assert.ok(recap);
  assert.ok(recap.startsWith('Context recovery:'));
  assert.ok(recap.includes('Client: Make the hero blue'));
  assert.ok(recap.includes('You: Done! Hero is blue.'));
  assert.ok(recap.endsWith('next message below.'));
});

test('failed user turns carry the not-applied note with error', () => {
  const recap = renderRecap([
    {
      role: 'user',
      content: 'Change the story section',
      status: 'failed',
      error: 'The change was undone because a page stopped loading.',
    },
  ]);
  assert.ok(recap);
  assert.ok(
    recap.includes(
      '[that request was not applied: The change was undone because a page stopped loading.]'
    )
  );
});

test('long messages are truncated and newlines collapsed', () => {
  const recap = renderRecap([
    { role: 'user', content: `a\nb  c${'x'.repeat(1000)}`, status: 'done', error: null },
  ]);
  assert.ok(recap);
  const line = recap.split('\n').find((l) => l.startsWith('Client: '));
  assert.ok(line);
  assert.ok(line.length <= 'Client: '.length + 400);
  assert.ok(line.includes('a b c'));
  assert.ok(line.endsWith('…'));
});

test('oldest lines drop first when over total budget', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    role: 'user' as const,
    content: `request ${i} ${'y'.repeat(390)}`,
    status: 'done',
    error: null,
  }));
  const recap = renderRecap(rows);
  assert.ok(recap);
  assert.ok(!recap.includes('request 0 '));
  assert.ok(recap.includes('request 11 '));
});

test('sanitizeForClient strips worktree paths and loopback urls', () => {
  const out = sanitizeForClient(
    'Error in /srv/sessions/abc/src/pages/index.astro: fetch http://127.0.0.1:4123/about failed',
    '/srv/sessions/abc'
  );
  assert.equal(
    out,
    'Error in /src/pages/index.astro: fetch the preview server/about failed'
  );
});
