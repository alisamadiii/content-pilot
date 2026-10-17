import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denyImageReads, IMAGE_PATH } from './run-session-claude';

const call = (tool_input: unknown) =>
  denyImageReads(
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input, session_id: 's', transcript_path: '', cwd: '' } as never,
    undefined,
    { signal: new AbortController().signal }
  );

test('Read on an image file is denied with a reason that points at the description', async () => {
  for (const file_path of ['public/hero.webp', '/abs/a.JPG', 'x.jpeg', 'y.png', 'z.gif', 'w.avif']) {
    const out = (await call({ file_path })) as { hookSpecificOutput?: Record<string, string> };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', file_path);
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /Image files must not be opened/);
  }
});

test('Read on anything else passes through untouched', async () => {
  for (const file_path of ['src/pages/index.astro', '_site.json', 'img.webp.md', 'notes/png']) {
    assert.deepEqual(await call({ file_path }), {}, file_path);
  }
  assert.deepEqual(await call({}), {});
  assert.deepEqual(await call(undefined), {});
  assert.deepEqual(await call({ file_path: 42 }), {});
});

test('IMAGE_PATH mirrors the Gemini policy: raster formats only, svg is not blocked', () => {
  assert.ok(IMAGE_PATH.test('a.webp'));
  assert.ok(!IMAGE_PATH.test('a.svg'));
  assert.ok(!IMAGE_PATH.test('a.heic'));
});
