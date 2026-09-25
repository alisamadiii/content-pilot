import { spawn } from 'child_process';
import { config as workerConfig } from '../worker/config';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { ClaudeUsage } from '../worker/runner';
import { previewConfig } from './config';

export type SessionClaudeRun = {
  resultText: string;
  claudeSessionId: string | null;
  timedOut: boolean;
  exitCode: number;
  usage: ClaudeUsage;
  /** Tail of stderr — only meaningful when exitCode !== 0. */
  stderr: string;
};

/**
 * One chat message = one headless Claude run in the session's working tree.
 * `--resume` carries the conversation across messages; the session id comes
 * from the stream-json init event of the first run and is persisted on the
 * session row. Every assistant stream event is forwarded to `onEvent` so the
 * hub chat renders thinking/tool/text activity live.
 */
export const runSessionClaude = (params: {
  cwd: string;
  prompt: string;
  claudeSessionId: string | null;
  onEvent: (event: unknown) => void;
}): Promise<SessionClaudeRun> => {
  return new Promise((resolve) => {
    const args = [
      '-p',
      params.prompt,
      '--model',
      previewConfig.claudeModel,
      '--append-system-prompt',
      SESSION_PROMPT,
      '--allowedTools',
      'Read,Edit,Write,Glob,Grep',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...(params.claudeSessionId ? ['--resume', params.claudeSessionId] : []),
    ];

    const child = spawn(workerConfig.claudeBin, args, {
      cwd: params.cwd,
      env: process.env,
    });

    let buffer = '';
    let resultText = '';
    let claudeSessionId = params.claudeSessionId;
    let timedOut = false;
    const usage: ClaudeUsage = {
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, previewConfig.messageTimeoutMs);

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (typeof event.session_id === 'string') {
        claudeSessionId = event.session_id;
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') {
          resultText = event.result;
        }
        const eventUsage = event.usage as
          | Record<string, number | undefined>
          | undefined;
        if (eventUsage) {
          const cacheRead = eventUsage.cache_read_input_tokens ?? 0;
          const cacheCreate = eventUsage.cache_creation_input_tokens ?? 0;
          usage.inputTokens =
            (eventUsage.input_tokens ?? 0) + cacheRead + cacheCreate;
          usage.outputTokens = eventUsage.output_tokens ?? null;
        }
        if (typeof event.total_cost_usd === 'number') {
          usage.costUsd = event.total_cost_usd;
        }
        if (event.modelUsage && typeof event.modelUsage === 'object') {
          usage.model = Object.keys(event.modelUsage)[0] ?? null;
        }
        return; // the pump emits its own message-done event
      }
      // Forward assistant activity: whole content blocks (tool_use) plus
      // partial-message deltas (thinking/text) for the live-typing feel.
      // Tool results and init noise stay server-side.
      if (event.type === 'assistant' || event.type === 'stream_event') {
        params.onEvent(event);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Mostly progress noise in stream-json mode, but on a non-zero exit the
      // tail is the only clue (auth failures, bad --resume target, ...).
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        resultText: '',
        claudeSessionId,
        timedOut: false,
        exitCode: 1,
        usage,
        stderr: error.message,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer) handleLine(buffer);
      resolve({
        resultText,
        claudeSessionId,
        timedOut,
        exitCode: code ?? 1,
        usage,
        stderr,
      });
    });
  });
};
