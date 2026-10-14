import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../worker/config';
import { previewConfig } from './config';

/**
 * Gemini CLI runtime for headless edit sessions. Everything lives under an
 * isolated home (`<WORKSPACE_DIR>/.gemini-home`, passed as GEMINI_CLI_HOME) so
 * the supervisor never touches `~/.gemini` and the config is identical on every
 * machine / container. Written idempotently at boot.
 *
 * Two layers:
 *  - settings.json — the token/latency diet. Removes the tools the editor must
 *    never use from the model's declarations (a policy deny only throws at call
 *    time; the declaration is still sent on every request), drops topic
 *    narration (`update_topic` calls), the directory tree, plan mode and
 *    subagents, and overrides the CLI's forced `thinkingLevel: HIGH` for the
 *    gemini-3 family with LOW. Our per-session system prompt (GEMINI_SYSTEM_MD)
 *    replaces the CLI's ~8k-token coding-agent prompt — see gemini-system-prompt.
 *  - admin policy — the hard safety floor (deny shell + network, deny image
 *    reads) in case a tool ever slips back into the set. `interactive = false`
 *    is required for the rule to apply in headless runs; loaded per-invocation
 *    via `--admin-policy` (tier 5, beats the default ask_user rules) because
 *    repo/workspace policies are non-functional upstream (gemini-cli #18186).
 *
 * The behavioral scope (content-only, no config/page edits) is carried by the
 * system prompt + the post-edit forbidden-path revert in chat.ts, same as the
 * Claude path.
 */

export const GEMINI_HOME = join(config.workspaceDir, '.gemini-home');
const GEMINI_DIR = join(GEMINI_HOME, '.gemini');

/** Absolute path to the deny policy — passed to the CLI via --admin-policy. */
export const GEMINI_POLICY_PATH = join(
  GEMINI_DIR,
  'policies',
  'content-pilot-lockdown.toml'
);

const POLICY = `# Written by content-pilot at boot. Denies shell + network tools for
# headless preview edit sessions.
[[rule]]
toolName = ["run_shell_command", "web_fetch", "google_web_search"]
decision = "deny"
priority = 200
interactive = false

# Chat uploads are described to the agent, never shown (token cost). An
# argsPattern rule denies the call without hiding read_file itself.
[[rule]]
toolName = ["read_file", "read_many_files"]
argsPattern = '\\.(webp|jpe?g|png|gif|avif)"'
decision = "deny"
priority = 210
interactive = false
`;

/** The only built-in tools an edit session needs. Everything else is unlisted. */
export const GEMINI_CORE_TOOLS = [
  'read_file',
  'replace',
  'write_file',
  'glob',
  'grep_search',
  'list_directory',
];

/**
 * Agentic turns per run before the CLI stops (exit 53). A locate-and-edit
 * should finish in 2–5; this is the runaway guard, not a target.
 */
export const GEMINI_MAX_TURNS = 16;

/**
 * The CLI's `chat-base-3` alias forces thinkingLevel HIGH on every gemini-3
 * model; flash-lite's own API default is minimal. LOW is plenty for
 * locate-and-edit and is the single biggest latency lever. Overriding the
 * base alias (not the model's own) also covers the CLI's silent model
 * resolution (e.g. `gemini-3.1-flash-lite` → `gemini-3.5-flash-lite`); the
 * explicit entry pins whatever model name the env configures.
 */
const modelAliases = (model: string) => ({
  'chat-base-3': {
    extends: 'chat-base',
    modelConfig: {
      generateContentConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
    },
  },
  [model]: {
    extends: 'chat-base-3',
    modelConfig: { model },
  },
});

export const buildGeminiSettings = (model: string) => ({
  general: {
    topicUpdateNarration: false,
    enableAutoUpdate: false,
    enableAutoUpdateNotification: false,
    plan: { enabled: false },
    checkpointing: { enabled: false },
    sessionRetention: { enabled: true, maxAge: '2d' },
  },
  privacy: { usageStatisticsEnabled: false },
  context: { includeDirectoryTree: false },
  tools: { core: GEMINI_CORE_TOOLS },
  model: { maxSessionTurns: GEMINI_MAX_TURNS, skipNextSpeakerCheck: true },
  experimental: { enableAgents: false, gemma: false },
  modelConfigs: { aliases: modelAliases(model) },
  mcpServers: {},
});

export const writeGeminiRuntime = (log: (message: string) => void): void => {
  try {
    mkdirSync(join(GEMINI_DIR, 'policies'), { recursive: true });
    writeFileSync(GEMINI_POLICY_PATH, POLICY);
    writeFileSync(
      join(GEMINI_DIR, 'settings.json'),
      JSON.stringify(buildGeminiSettings(previewConfig.geminiModel), null, 2)
    );
    log(`gemini runtime written (${GEMINI_HOME})`);
  } catch (error) {
    log(`gemini runtime write failed: ${(error as Error).message}`);
  }
};
