import {
  query,
  AbortError,
  createSdkMcpServer,
  tool,
  type HookCallback,
  type PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { ClaudeUsage } from './usage';
import { previewConfig } from './config';
import { describeReplace, REPLACE_TOOL_DESCRIPTION, replaceInFiles } from './replace-in-files';
import { replaceToolInput } from './replace-mcp-server';

/** Tool names as the SDK exposes them (`mcp__<server>__<tool>`). */
export const REPLACE_TOOL_NAME = 'mcp__pilot__replace_in_files';

/**
 * In-process MCP server with the one custom tool an edit session needs:
 * bulk literal replace, so a brand-value swap is one call instead of a
 * Read+Edit per file. Bound to the session clone.
 */
export const pilotTools = (cwd: string) =>
  createSdkMcpServer({
    name: 'pilot',
    version: '1.0.0',
    tools: [
      tool('replace_in_files', REPLACE_TOOL_DESCRIPTION, replaceToolInput, async ({ find, replace, include }) => {
        const result = replaceInFiles({ dir: cwd, find, replace, include });
        return {
          content: [{ type: 'text', text: describeReplace(result) }],
          isError: !result.ok,
        };
      }),
    ],
  });

// Chat uploads are described to the agent, never shown (token cost); the
// bytes also live outside cwd. This hook is the in-process backstop for any
// other image in the repo: Read returns images as vision content, so deny it.
export const IMAGE_PATH = /\.(webp|jpe?g|png|gif|avif)$/i;
export const denyImageReads: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  const path = String(
    (pre.tool_input as { file_path?: unknown } | undefined)?.file_path ?? ''
  );
  if (!IMAGE_PATH.test(path)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Image files must not be opened. Use the description given in the request instead.',
    },
  };
};

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
  /** External abort (user "pause"); aborts the run without the timeout label. */
  signal?: AbortSignal;
  /** Gemini-only (its replacement system prompt file); ignored here. */
  systemPromptPath?: string;
  /** Gemini-only (per-repo key tier); ignored here. */
  geminiApiKey?: string;
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
    cacheReadTokens: null,
    costUsd: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, previewConfig.messageTimeoutMs);
  // User "pause": abort the run. `timedOut` stays false so the caller can tell
  // a pause apart from a timeout (the external signal is the source of truth).
  if (params.signal) {
    if (params.signal.aborted) controller.abort();
    else params.signal.addEventListener("abort", () => controller.abort());
  }

  const run = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd,
      model: previewConfig.claudeModel,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SESSION_PROMPT },
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', REPLACE_TOOL_NAME],
      mcpServers: { pilot: pilotTools(params.cwd) },
      // Hard backstop: acceptEdits only auto-approves edits; anything that
      // could reach outside the working tree is removed from context entirely.
      disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Task'],
      permissionMode: 'acceptEdits',
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [denyImageReads] }] },
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
          // Shown separately in the hub: most of a resumed run's input is
          // cache reads, which cost ~10% of fresh tokens.
          usage.cacheReadTokens = cacheRead;
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
