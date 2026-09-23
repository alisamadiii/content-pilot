import { spawn } from 'child_process';
import { config } from './config';
import { GUARDRAIL_PROMPT } from './guardrails';

export type ClaudeUsage = {
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export type ClaudeRun = {
  resultText: string;
  logs: string;
  timedOut: boolean;
  exitCode: number;
  usage: ClaudeUsage;
};

/**
 * Runs one headless Claude Code invocation inside the repo clone.
 * Tools are restricted to read/edit — git is handled by the worker itself.
 * `onLog` receives the accumulated (truncated) output every few seconds so
 * the dashboard can show a live view of what Claude is doing.
 */
export const runClaude = (params: {
  cwd: string;
  prompt: string;
  onLog?: (logs: string) => void;
}): Promise<ClaudeRun> => {
  return new Promise((resolve) => {
    const args = [
      '-p',
      params.prompt,
      '--model',
      config.claudeModel,
      '--append-system-prompt',
      GUARDRAIL_PROMPT,
      '--allowedTools',
      'Read,Edit,Write,Glob,Grep',
      // stream-json emits one JSON event per line as Claude works, which
      // powers the live session view in the dashboard.
      '--output-format',
      'stream-json',
      '--verbose',
    ];

    const child = spawn(config.claudeBin, args, {
      cwd: params.cwd,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.jobTimeoutMs);

    const flusher = params.onLog
      ? setInterval(() => {
          params.onLog!(assemble());
        }, 5_000)
      : null;

    const assemble = () =>
      truncate(`${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const emptyUsage: ClaudeUsage = {
      model: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };

    child.on('error', (error) => {
      clearTimeout(timer);
      if (flusher) clearInterval(flusher);
      resolve({
        resultText: '',
        logs: assemble() + `\n--- spawn error ---\n${error.message}`,
        timedOut: false,
        exitCode: 1,
        usage: emptyUsage,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (flusher) clearInterval(flusher);

      // stream-json emits one JSON event per line; the final "result" event
      // carries the result text, token usage, and cost.
      let resultText = stdout;
      const usage: ClaudeUsage = { ...emptyUsage };
      const lines = stdout.trim().split('\n').reverse();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event?.type === 'result') {
            if (typeof event.result === 'string') {
              resultText = event.result;
            }
            if (event.usage) {
              const cacheRead = event.usage.cache_read_input_tokens ?? 0;
              const cacheCreate = event.usage.cache_creation_input_tokens ?? 0;
              usage.inputTokens =
                (event.usage.input_tokens ?? 0) + cacheRead + cacheCreate;
              usage.outputTokens = event.usage.output_tokens ?? null;
            }
            if (typeof event.total_cost_usd === 'number') {
              usage.costUsd = event.total_cost_usd;
            }
            if (event.modelUsage && typeof event.modelUsage === 'object') {
              usage.model = Object.keys(event.modelUsage)[0] ?? null;
            }
            break;
          }
        } catch {
          // not a JSON line, keep scanning
        }
      }

      resolve({
        resultText,
        logs: assemble(),
        timedOut,
        exitCode: code ?? 1,
        usage,
      });
    });
  });
};

const truncate = (text: string) => {
  if (Buffer.byteLength(text, 'utf8') <= config.maxLogBytes) {
    return text;
  }
  return `${text.slice(0, config.maxLogBytes)}\n... [truncated]`;
};
