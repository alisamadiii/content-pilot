import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SESSION_PROMPT } from '../worker/guardrails';
import type { RepoContext } from './repo-context';

const ws = mkdtempSync(join(tmpdir(), 'cp-gsp-'));
process.env.WORKSPACE_DIR = ws;

const repo = (text: string): RepoContext => ({
  framework: 'astro',
  routes: new Map(),
  components: [],
  cmsFiles: [],
  imageDirs: [],
  publicRel: 'public',
  agentNotes: '',
  text,
});

test('system prompt = shared editing rules, then tool rules, then repo facts', async () => {
  const { buildGeminiSystemPrompt, GEMINI_TOOL_RULES } = await import('./gemini-system-prompt');
  const out = buildGeminiSystemPrompt(repo('# This site\nFramework: astro.'));
  assert.ok(out.startsWith(SESSION_PROMPT), 'starts with SESSION_PROMPT');
  assert.ok(out.endsWith('# This site\nFramework: astro.'), 'ends with repo text');
  assert.equal(out, `${SESSION_PROMPT}\n\n${GEMINI_TOOL_RULES}\n\n# This site\nFramework: astro.`);
  assert.ok(out.indexOf(GEMINI_TOOL_RULES) > out.indexOf('FORBIDDEN'));
});

test('tool rules tell the model not to re-read pinned files and never to run commands', async () => {
  const { GEMINI_TOOL_RULES } = await import('./gemini-system-prompt');
  assert.match(GEMINI_TOOL_RULES, /Do not read a file that was given to you/);
  assert.match(GEMINI_TOOL_RULES, /cannot run commands or reach the network/);
  assert.match(GEMINI_TOOL_RULES, /strictly valid JSON/);
  assert.match(GEMINI_TOOL_RULES, /skill block/);
});

test('prompt file lives outside any clone, under <WORKSPACE_DIR>/.cp-prompts/<session>.md', async () => {
  const { geminiPromptPath, writeGeminiSystemPrompt, removeGeminiSystemPrompt, buildGeminiSystemPrompt } =
    await import('./gemini-system-prompt');
  assert.equal(geminiPromptPath('abc'), join(ws, '.cp-prompts', 'abc.md'));
  const path = await writeGeminiSystemPrompt('abc', repo('facts'));
  assert.equal(path, geminiPromptPath('abc'));
  assert.equal(readFileSync(path, 'utf8'), buildGeminiSystemPrompt(repo('facts')));
  // Rewritten per message: new facts replace old.
  await writeGeminiSystemPrompt('abc', repo('newer facts'));
  assert.ok(readFileSync(path, 'utf8').endsWith('newer facts'));
  await removeGeminiSystemPrompt('abc');
  assert.equal(existsSync(path), false);
  // Removing twice (torn down session) is a no-op, not an error.
  await assert.doesNotReject(() => removeGeminiSystemPrompt('abc'));
});
