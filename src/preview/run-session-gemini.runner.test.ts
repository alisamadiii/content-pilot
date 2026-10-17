import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// The runner spawns `gemini` from PATH. A fake binary (shell script) stands in,
// driven by FAKE_MODE, and records what it received under FAKE_OUT — so the
// NDJSON parsing, exit-code mapping, args/env/stdin contract and abort paths
// are exercised end to end without the real CLI.
const ws = mkdtempSync(join(tmpdir(), 'cp-gemini-run-'));
process.env.WORKSPACE_DIR = ws;
process.env.SESSION_GEMINI_MODEL = 'gemini-fake';
const binDir = join(ws, 'bin');
mkdirSync(binDir);
const fakeOut = join(ws, 'out');
mkdirSync(fakeOut);
writeFileSync(
  join(binDir, 'gemini'),
  `#!/bin/sh
cat > "$FAKE_OUT/stdin.txt"
printf '%s\\n' "$@" > "$FAKE_OUT/args.txt"
env | grep '^GEMINI' | sort > "$FAKE_OUT/env.txt"
case "$FAKE_MODE" in
  ok)
    echo '{"type":"init","session_id":"sess-1","model":"m"}'
    echo '{"type":"message","role":"user","content":"echo of prompt"}'
    echo '{"type":"message","role":"assistant","content":"Hel"}'
    echo 'not json noise'
    echo ''
    echo '{"type":"tool_use","tool_name":"replace","parameters":{"file_path":"a.astro"}}'
    echo '{"type":"message","role":"assistant","content":"lo"}'
    printf '%s' '{"type":"result","status":"success","response":"Done.","stats":{"input_tokens":1000,"output_tokens":10}}'
    exit 0;;
  stream-only)
    echo '{"type":"init","session_id":"sess-2"}'
    echo '{"type":"message","role":"assistant","content":"Hello"}'
    echo '{"type":"result","status":"success","model":"gemini-real","stats":{"input_tokens":5,"output_tokens":1}}'
    exit 0;;
  split)
    printf '%s' '{"type":"message","role":"assis'
    sleep 0.2
    printf '%s\\n' 'tant","content":"joined"}'
    echo '{"type":"result","status":"success"}'
    exit 0;;
  turn-limit)
    echo '{"type":"message","role":"assistant","content":"partial"}'
    exit 53;;
  error-result)
    echo '{"type":"result","status":"error","error":{"message":"[API Error: quota]"}}'
    exit 0;;
  stderr-noise)
    echo 'warning: something' >&2
    echo '{"type":"result","status":"success"}'
    exit 0;;
  exit-nonzero)
    echo '{"type":"result","status":"success"}'
    exit 2;;
  no-result)
    echo '{"type":"message","role":"assistant","content":"x"}'
    exit 0;;
  hang)
    exec sleep 30;;
esac
`
);
chmodSync(join(binDir, 'gemini'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${binDir}:${realPath}`;
process.env.FAKE_OUT = fakeOut;

type Mod = typeof import('./run-session-gemini');
let mod: Mod;
let previewConfig: typeof import('./config').previewConfig;
let setup: typeof import('./gemini-setup');
before(async () => {
  mod = await import('./run-session-gemini');
  ({ previewConfig } = await import('./config'));
  setup = await import('./gemini-setup');
});
after(() => {
  process.env.PATH = realPath;
});

const run = (mode: string, over: Partial<Parameters<Mod['runSessionGemini']>[0]> = {}) => {
  process.env.FAKE_MODE = mode;
  const events: unknown[] = [];
  const promise = mod.runSessionGemini({
    cwd: ws,
    prompt: 'Change the headline',
    claudeSessionId: null,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { promise, events };
};
const recorded = (name: string) => readFileSync(join(fakeOut, name), 'utf8');

test('happy path: session id, streamed text + tool events, result text, tokens → cost', async () => {
  const { promise, events } = run('ok', { systemPromptPath: '/tmp/sys.md' });
  const out = await promise;
  assert.equal(out.exitCode, 0);
  assert.equal(out.gotResult, true);
  assert.equal(out.timedOut, false);
  assert.equal(out.claudeSessionId, 'sess-1');
  assert.equal(out.resultText, 'Done.');
  assert.equal(out.stderr, '');
  assert.deepEqual(out.usage, {
    model: 'gemini-fake',
    inputTokens: 1000,
    outputTokens: 10,
    cacheReadTokens: null,
    costUsd: mod.geminiCostUsd(1000, 10),
  });
  assert.deepEqual(events, [
    mod.toHubTextDelta('Hel'),
    mod.toHubToolUse('Edit', { file_path: 'a.astro' }),
    mod.toHubTextDelta('lo'),
  ]);
  // Contract with the CLI: prompt on stdin, model/approval/format args, env.
  assert.equal(recorded('stdin.txt'), 'Change the headline');
  assert.deepEqual(recorded('args.txt').trim().split('\n'), [
    '-m', 'gemini-fake', '--approval-mode', 'auto_edit', '--output-format', 'stream-json',
  ]);
  const env = recorded('env.txt');
  assert.match(env, /^GEMINI_CLI_HOME=.*\.gemini-home$/m);
  assert.match(env, /^GEMINI_CLI_TRUST_WORKSPACE=true$/m);
  assert.match(env, /^GEMINI_SYSTEM_MD=\/tmp\/sys\.md$/m);
});

test('resume id and admin policy are passed only when present; no system prompt → no env var', async () => {
  const policy = setup.GEMINI_POLICY_PATH;
  mkdirSync(dirname(policy), { recursive: true });
  writeFileSync(policy, '# policy');
  try {
    await run('ok', { claudeSessionId: 'prev-id' }).promise;
    const args = recorded('args.txt').trim().split('\n');
    assert.deepEqual(args.slice(-4), ['--admin-policy', policy, '-r', 'prev-id']);
    assert.doesNotMatch(recorded('env.txt'), /GEMINI_SYSTEM_MD/);
  } finally {
    rmSync(policy);
  }
  await run('ok').promise;
  assert.doesNotMatch(recorded('args.txt'), /--admin-policy|-r/);
});

test('a result without text falls back to the streamed text; result model wins', async () => {
  const out = await run('stream-only').promise;
  assert.equal(out.resultText, 'Hello');
  assert.equal(out.claudeSessionId, 'sess-2');
  assert.equal(out.usage.model, 'gemini-real');
  assert.equal(out.exitCode, 0);
});

test('a JSON line split across stdout chunks is reassembled', async () => {
  const { promise, events } = run('split');
  await promise;
  assert.deepEqual(events, [mod.toHubTextDelta('joined')]);
});

test('exit 53 (turn cap) fails with the friendly turn-limit message, keeping partial text', async () => {
  const out = await run('turn-limit').promise;
  assert.equal(out.exitCode, 1);
  assert.equal(out.stderr, mod.TURN_LIMIT_MESSAGE);
  assert.equal(out.timedOut, false);
  assert.equal(out.gotResult, false);
  assert.equal(out.resultText, 'partial');
});

test('an error result fails the run with the API message even though the process exited 0', async () => {
  const out = await run('error-result').promise;
  assert.equal(out.exitCode, 1);
  assert.equal(out.gotResult, true);
  assert.match(out.stderr, /\[API Error: quota\]/);
});

test('stderr noise with a successful result is captured but does not fail the run', async () => {
  const out = await run('stderr-noise').promise;
  assert.equal(out.exitCode, 0);
  assert.match(out.stderr, /warning: something/);
});

test('a non-zero exit fails the run even with a successful result; a missing result fails too', async () => {
  const nonzero = await run('exit-nonzero').promise;
  assert.equal(nonzero.exitCode, 1);
  assert.equal(nonzero.gotResult, true);
  const noResult = await run('no-result').promise;
  assert.equal(noResult.exitCode, 1);
  assert.equal(noResult.gotResult, false);
  assert.equal(noResult.resultText, 'x');
});

test('user pause (abort signal) kills the child: failed but not timedOut', async () => {
  const controller = new AbortController();
  const { promise } = run('hang', { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const out = await promise;
  assert.equal(out.exitCode, 1);
  assert.equal(out.timedOut, false);
  assert.equal(out.gotResult, false);
});

test('an already-aborted signal kills the child immediately', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const out = await run('hang', { signal: controller.signal }).promise;
  assert.equal(out.exitCode, 1);
  assert.ok(Date.now() - started < 5_000);
});

test('the message timeout kills the child and is reported as timedOut', async () => {
  const original = previewConfig.messageTimeoutMs;
  previewConfig.messageTimeoutMs = 200;
  try {
    const out = await run('hang').promise;
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, 1);
  } finally {
    previewConfig.messageTimeoutMs = original;
  }
});

test('a missing gemini binary is a failed run with the spawn error, never a hang', async () => {
  process.env.PATH = '/nonexistent-dir';
  try {
    const out = await run('ok').promise;
    assert.equal(out.exitCode, 1);
    assert.equal(out.gotResult, false);
    assert.match(out.stderr, /ENOENT/);
  } finally {
    process.env.PATH = `${binDir}:${realPath}`;
  }
});
