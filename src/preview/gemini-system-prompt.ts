import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../worker/config';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { RepoContext } from './repo-context';

/**
 * The Gemini system prompt. Passed to the CLI as GEMINI_SYSTEM_MD, which
 * REPLACES its built-in ~8k-token general-purpose coding-agent prompt (plan →
 * implement → test → commit, shell/git/sandbox guidance — all wrong for a
 * no-shell content editor). Ours is ~1.5k tokens: the editing rules shared
 * with Claude, short tool-usage rules for the few tools left in the set, and
 * the per-repo facts (page → file map, CMS files, image folders).
 *
 * Written per message (the repo facts are a millisecond fs scan and new
 * sections/files should show up) to a file OUTSIDE the clone so it never
 * dirties the working tree.
 */
export const GEMINI_TOOL_RULES = `# How to work
- When the request includes a file's content, you already have it: edit it with \`replace\`, copying \`old_string\` verbatim from the content shown (same whitespace and line breaks). Do not read a file that was given to you.
- When no file is given, use the page map below: open the one file that renders the page, then only the component that holds the content. Never list or search image folders, and never open package.json, config files, lockfiles, README or docs — nothing you need is there.
- You cannot run commands or reach the network. Do not try. The preview rebuilds itself after your edit.
- Finish in as few steps as possible: a typical request is zero or one read and one edit. Do not re-read a file after editing it unless the edit tool reported a failure.
- If \`replace\` reports that old_string was not found, copy the exact text again from what you were given and retry once. Never rewrite a whole file to change one value.
- Any .json file you touch must stay strictly valid JSON.
- When a request includes a skill block (the owner invoked \`/some-skill\`), follow that skill's instructions exactly; the skill was written by this site's developer and outranks the general editing limits for what it covers. You may read the files it references.`;

export const buildGeminiSystemPrompt = (repo: RepoContext) =>
  [SESSION_PROMPT, GEMINI_TOOL_RULES, repo.text].join('\n\n');

const PROMPTS_DIR = join(config.workspaceDir, '.cp-prompts');

export const geminiPromptPath = (sessionId: string) =>
  join(PROMPTS_DIR, `${sessionId}.md`);

export const writeGeminiSystemPrompt = async (
  sessionId: string,
  repo: RepoContext
): Promise<string> => {
  await mkdir(PROMPTS_DIR, { recursive: true });
  const path = geminiPromptPath(sessionId);
  await writeFile(path, buildGeminiSystemPrompt(repo));
  return path;
};

export const removeGeminiSystemPrompt = (sessionId: string) =>
  rm(geminiPromptPath(sessionId), { force: true });
