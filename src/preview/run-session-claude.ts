import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { ClaudeUsage } from '../worker/runner';
import { previewConfig } from './config';

export type SessionClaudeRun = {
  resultText: string;
  claudeSessionId: string | null;
  timedOut: boolean;
  exitCode: number;
  usage: ClaudeUsage;
  /** Tail of the failure message — only meaningful when exitCode !== 0. */
  stderr: string;
  /**
   * True when the SDK emitted its final `result` message — the transcript is
   * durably written and the run's session id is a safe `resume` target.
   * Aborted (timed-out) runs never emit it; persisting their session id
   * would make the next message resume a conversation that doesn't exist.
   */
  gotResult: boolean;
};

/**
 * One chat message = one headless Agent SDK run in the session's working tree.
 * `resume` carries the conversation across messages; the session id comes from
 * the first run's messages and is persisted on the session row. Every
 * assistant stream message is forwarded to `onEvent` so the hub chat renders
 * thinking/tool/text activity live. Message shapes mirror the CLI's
 * stream-json output, so the hub reducer needs no changes.
 */
export const runSessionClaude = async (params: {
  cwd: string;
  prompt: string;
  claudeSessionId: string | null;
  onEvent: (event: unknown) => void;
}): Promise<SessionClaudeRun> => {
  let resultText = '';
  let claudeSessionId = params.claudeSessionId;
  let timedOut = false;
  let gotResult = false;
  let failed = false;
  let stderr = '';
  const usage: ClaudeUsage = {
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, previewConfig.messageTimeoutMs);

  const run = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      model: previewConfig.claudeModel,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SESSION_PROMPT },
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      // Hard backstop: acceptEdits only auto-approves edits; anything that
      // could reach outside the working tree is removed from context entirely.
      disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Task'],
      permissionMode: 'acceptEdits',
      // Load the client repo's .claude/ tree (skills, commands) from cwd.
      settingSources: ['project'],
      // Auto-configures the Skill tool; without this the tool allowlist above
      // would leave skill invocations un-approved in headless mode.
      skills: 'all',
      includePartialMessages: true,
      resume: params.claudeSessionId ?? undefined,
      abortController: controller,
    },
  });

  try {
    for await (const message of run) {
      const sessionId = (message as { session_id?: unknown }).session_id;
      if (typeof sessionId === 'string') {
        claudeSessionId = sessionId;
      }
      if (message.type === 'result') {
        gotResult = true;
        const event = message as unknown as Record<string, unknown>;
        if (typeof event.result === 'string') {
          resultText = event.result;
        }
        if (event.is_error === true) {
          failed = true;
          stderr = typeof event.result === 'string' ? event.result : 'agent run errored';
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
        continue; // the pump emits its own message-done event
      }
      // Forward assistant activity: whole content blocks (tool_use) plus
      // partial-message deltas (thinking/text) for the live-typing feel.
      // Tool results and init noise stay server-side.
      if (message.type === 'assistant' || message.type === 'stream_event') {
        params.onEvent(message);
      }
    }
  } catch (error) {
    failed = true;
    if (!(error instanceof AbortError) && !timedOut) {
      stderr = ((error as Error)?.message ?? 'agent sdk error').slice(-2000);
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    resultText,
    claudeSessionId,
    timedOut,
    exitCode: failed || timedOut ? 1 : 0,
    usage,
    stderr,
    gotResult,
  };
};
