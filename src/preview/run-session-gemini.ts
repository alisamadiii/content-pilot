import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { ClaudeUsage } from './usage';
import type { SessionClaudeRun } from './run-session-claude';
import { previewConfig } from './config';
import { GEMINI_POLICY_PATH } from './gemini-setup';

/**
 * One chat message = one headless Gemini CLI run in the session's working tree.
 * Mirrors runSessionClaude's contract exactly (same params + SessionClaudeRun
 * return) so chat.ts can dispatch to either provider with no other changes.
 *
 * The Gemini CLI streams newline-delimited JSON events (`--output-format
 * stream-json`). We normalize them into the SAME shapes the hub reducer
 * (`use-session-events.ts`) already folds for Claude, so the chat renders
 * identically (tool lines, streamed text). Cross-message context is carried by
 * `--resume <sessionId>`; the id comes from the `init` event.
 *
 * Field-name caveat: the CLI docs enumerate the event TYPES (init/message/
 * tool_use/tool_result/result/error) but not the exact sub-field names. The
 * extractors below probe several candidate keys; set GEMINI_DEBUG_STREAM=1 to
 * log raw lines and tighten them against a real run.
 */

const DEBUG = process.env.GEMINI_DEBUG_STREAM === '1';

/** Map a Gemini tool name to the Claude name the hub's toolLabel understands. */
export const TOOL_NAME_MAP: Record<string, string> = {
  read_file: 'Read',
  read_many_files: 'Read',
  write_file: 'Write',
  replace: 'Edit',
  edit: 'Edit',
  glob: 'Glob',
  grep_search: 'Grep',
  search_file_content: 'Grep',
};

const firstString = (
  obj: Record<string, unknown> | null | undefined,
  keys: string[]
): string | null => {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
};

const firstNumber = (
  obj: Record<string, unknown> | null | undefined,
  keys: string[]
): number | null => {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

/** Pull token counts from wherever the CLI hangs them (stats / usage / metadata). */
export const extractTokens = (
  evt: Record<string, unknown>
): { input: number | null; output: number | null } => {
  const buckets = [
    evt,
    asRecord(evt.stats),
    asRecord(evt.usage),
    asRecord(evt.metadata),
    asRecord(asRecord(evt.stats)?.tokens),
    asRecord(asRecord(evt.stats)?.models),
  ].filter(Boolean) as Record<string, unknown>[];
  let input: number | null = null;
  let output: number | null = null;
  for (const bucket of buckets) {
    input =
      input ??
      firstNumber(bucket, [
        'input_tokens',
        'inputTokens',
        'prompt_tokens',
        'promptTokenCount',
        'input',
      ]);
    output =
      output ??
      firstNumber(bucket, [
        'output_tokens',
        'outputTokens',
        'candidates_tokens',
        'candidatesTokenCount',
        'completion_tokens',
        'output',
      ]);
  }
  return { input, output };
};

/** A raw Gemini stream-json event, normalized to a provider-agnostic shape. */
export type GeminiInterpretation =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown> }
  | {
      kind: 'result';
      text: string | null;
      model: string | null;
      input: number | null;
      output: number | null;
      failed: boolean;
      error: string | null;
    }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

/**
 * Pure interpreter for one Gemini stream-json event (verified against real
 * v0.61 shapes). Kept separate from the runner so it can be unit-tested without
 * spawning a subprocess. Skips the role:"user" prompt echo; maps tool names +
 * input keys to the Claude shapes the hub reducer expects; reads token stats
 * and success/error from the `result` event.
 */
export const interpretGeminiEvent = (
  evt: Record<string, unknown>
): GeminiInterpretation => {
  const type = typeof evt.type === 'string' ? evt.type : '';
  switch (type) {
    case 'init': {
      const id =
        firstString(evt, ['session_id', 'sessionId', 'id']) ??
        firstString(asRecord(evt.session), ['id', 'session_id']);
      return id ? { kind: 'session', sessionId: id } : { kind: 'ignore' };
    }
    case 'message':
    case 'assistant':
    case 'content': {
      if (firstString(evt, ['role']) === 'user') return { kind: 'ignore' };
      const text =
        firstString(evt, ['text', 'content', 'delta', 'chunk']) ??
        firstString(asRecord(evt.message), ['text', 'content']) ??
        firstString(asRecord(evt.delta), ['text']);
      return text ? { kind: 'text', text } : { kind: 'ignore' };
    }
    case 'tool_use':
    case 'tool_call': {
      const rawName =
        firstString(evt, ['name', 'tool', 'toolName', 'tool_name']) ?? '';
      const name = TOOL_NAME_MAP[rawName] ?? rawName;
      const rawInput =
        asRecord(evt.args) ??
        asRecord(evt.input) ??
        asRecord(evt.arguments) ??
        asRecord(evt.parameters) ??
        {};
      const filePath = firstString(rawInput, [
        'file_path',
        'filePath',
        'absolute_path',
        'path',
      ]);
      const pattern = firstString(rawInput, ['pattern', 'query', 'glob']);
      const input: Record<string, unknown> = {};
      if (filePath) input.file_path = filePath;
      if (pattern) input.pattern = pattern;
      return { kind: 'tool', name, input };
    }
    case 'result': {
      const text =
        firstString(evt, ['response', 'result', 'text', 'content']) ??
        firstString(asRecord(evt.result), ['text', 'content', 'response']);
      const model = firstString(evt, ['model']);
      const { input, output } = extractTokens(evt);
      const status = firstString(evt, ['status']);
      const error =
        firstString(evt, ['error']) ??
        firstString(asRecord(evt.error), ['message']);
      const failed = Boolean(error) || (!!status && status !== 'success');
      return {
        kind: 'result',
        text,
        model,
        input,
        output,
        failed,
        error: failed ? (error ?? `gemini run ${status}`) : null,
      };
    }
    case 'error': {
      const message =
        firstString(evt, ['message', 'error']) ??
        firstString(asRecord(evt.error), ['message']);
      return message ? { kind: 'error', message } : { kind: 'ignore' };
    }
    default:
      return { kind: 'ignore' };
  }
};

/** Shape an assistant text chunk as the hub reducer's streamed-text event. */
export const toHubTextDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

/** Shape a tool call as the hub reducer's assistant/tool_use event. */
export const toHubToolUse = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, input }] },
});

/** Per-message cost from token counts (Gemini reports tokens, not dollars). */
export const geminiCostUsd = (
  input: number | null,
  output: number | null
): number | null =>
  input === null && output === null
    ? null
    : ((input ?? 0) * previewConfig.geminiInPricePerM +
        (output ?? 0) * previewConfig.geminiOutPricePerM) /
      1_000_000;

export const runSessionGemini = async (params: {
  cwd: string;
  prompt: string;
  claudeSessionId: string | null;
  onEvent: (event: unknown) => void;
  /** External abort (user "pause"); kills the child without the timeout label. */
  signal?: AbortSignal;
}): Promise<SessionClaudeRun> => {
  let resultText = '';
  let streamedText = '';
  let geminiSessionId = params.claudeSessionId;
  let timedOut = false;
  let gotResult = false;
  let failed = false;
  let stderr = '';
  const usage: ClaudeUsage = {
    model: previewConfig.geminiModel,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };

  const args = [
    '-m',
    previewConfig.geminiModel,
    '--approval-mode',
    'auto_edit',
    '--output-format',
    'stream-json',
  ];
  // Hard tool lockdown: deny shell + network entirely (admin tier beats the
  // default rules). Belt to the auto_edit braces — even if the policy is
  // missing, headless auto-denies non-edit tool confirmations.
  if (existsSync(GEMINI_POLICY_PATH)) {
    args.push('--admin-policy', GEMINI_POLICY_PATH);
  }
  if (params.claudeSessionId) {
    args.push('-r', params.claudeSessionId);
  }

  const child = spawn('gemini', args, {
    cwd: params.cwd,
    env: {
      ...process.env,
      // Skip the interactive folder-trust gate in headless/CI.
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, previewConfig.messageTimeoutMs);
  // User "pause": kill the child. `timedOut` stays false so the caller can tell
  // a pause apart from a timeout.
  const onAbort = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  };
  if (params.signal) {
    if (params.signal.aborted) onAbort();
    else params.signal.addEventListener('abort', onAbort);
  }

  // Gemini's system prompt can't be appended (only fully replaced via
  // GEMINI_SYSTEM_MD, which would drop the CLI's own coding instructions), so
  // the guardrails ride at the top of the prompt — like the Claude preset
  // append. Sent every run (cheap on Flash); resume keeps conversational
  // context but not a sticky system message.
  const fullPrompt = `${SESSION_PROMPT}\n\n---\n\n${params.prompt}`;
  // The prompt (with guardrails + any recap) goes in via stdin — avoids argv
  // length limits.
  child.stdin.write(fullPrompt);
  child.stdin.end();

  const handleEvent = (evt: Record<string, unknown>) => {
    const it = interpretGeminiEvent(evt);
    switch (it.kind) {
      case 'session':
        geminiSessionId = it.sessionId;
        return;
      case 'text':
        streamedText += it.text;
        params.onEvent(toHubTextDelta(it.text));
        return;
      case 'tool':
        params.onEvent(toHubToolUse(it.name, it.input));
        return;
      case 'result': {
        gotResult = true;
        if (it.text) resultText = it.text;
        if (it.model) usage.model = it.model;
        usage.inputTokens = it.input;
        usage.outputTokens = it.output;
        usage.costUsd = geminiCostUsd(it.input, it.output);
        if (it.failed) {
          failed = true;
          stderr = (it.error ?? 'gemini run failed').slice(-2000);
        }
        return;
      }
      case 'error':
        // Non-fatal warnings also arrive as `error` — capture the text; the
        // process exit code decides failure.
        stderr = `${stderr}${stderr ? '\n' : ''}${it.message}`.slice(-2000);
        return;
      default:
        return;
    }
  };

  let buffer = '';
  const consume = (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (DEBUG) log(`gemini raw: ${line.slice(0, 500)}`);
      try {
        handleEvent(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Non-JSON noise on stdout — ignore.
      }
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      failed = true;
      stderr = (error.message || 'gemini spawn error').slice(-2000);
      resolve(1);
    });
    child.on('close', (code) => {
      // Flush any trailing buffered line without a newline.
      if (buffer.trim()) {
        if (DEBUG) log(`gemini raw (tail): ${buffer.trim().slice(0, 500)}`);
        try {
          handleEvent(JSON.parse(buffer.trim()) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
      }
      resolve(code ?? 0);
    });
  });
  clearTimeout(timer);

  if (!resultText) resultText = streamedText;
  const clean = gotResult && !failed && !timedOut && exitCode === 0;

  return {
    resultText,
    claudeSessionId: geminiSessionId,
    timedOut,
    exitCode: clean ? 0 : 1,
    usage,
    stderr,
    gotResult,
  };
};

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};
