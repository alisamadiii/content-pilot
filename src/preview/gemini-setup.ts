import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Gemini CLI tool lockdown. A `deny` rule removes the tool from the model's
 * context entirely, so the agent can only ever read/write/edit files inside
 * the working tree — never run a shell command or reach the network. Written
 * to the USER-tier policy dir (`~/.gemini/policies/`) because repo/workspace
 * policies are currently non-functional upstream (google-gemini/gemini-cli
 * #18186). Idempotent; runs once at supervisor boot.
 *
 * The behavioral scope (content-only, no config/page edits) is carried by
 * SESSION_PROMPT + the post-edit forbidden-path revert in chat.ts, same as the
 * Claude path — this policy is the hard safety floor.
 */
// `interactive = false` is required for the rule to apply in headless runs
// (matches the builtin write.toml deny rules); a deny fully hides the tool
// from the model. Loaded per-invocation via `--admin-policy` (tier 5, beats
// the default ask_user rules) rather than relying on auto-discovery.
const POLICY = `# Written by content-pilot at boot. Denies shell + network tools for
# headless preview edit sessions.
[[rule]]
toolName = ["run_shell_command", "web_fetch", "web_search", "google_web_search"]
decision = "deny"
priority = 200
interactive = false
`;

/** Absolute path to the deny policy — passed to the CLI via --admin-policy. */
export const GEMINI_POLICY_PATH = join(
  homedir(),
  '.gemini',
  'policies',
  'content-pilot-lockdown.toml'
);

export const writeGeminiPolicy = (log: (message: string) => void): void => {
  try {
    mkdirSync(join(homedir(), '.gemini', 'policies'), { recursive: true });
    writeFileSync(GEMINI_POLICY_PATH, POLICY);
    log('gemini tool lockdown policy written (~/.gemini/policies)');
  } catch (error) {
    log(`gemini policy write failed: ${(error as Error).message}`);
  }
};
