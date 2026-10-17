import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// config.workspaceDir is read at import, so pin WORKSPACE_DIR to a temp dir
// before the dynamic import below.
const ws = mkdtempSync(join(tmpdir(), 'cp-gemini-'));
process.env.WORKSPACE_DIR = ws;
process.env.SESSION_GEMINI_MODEL = 'gemini-test-model';

test('settings expose only the six edit tools — never shell or web; the only MCP server is ours', async () => {
  const { buildGeminiSettings, GEMINI_CORE_TOOLS } = await import('./gemini-setup');
  const s = buildGeminiSettings('m');
  assert.deepEqual(s.tools.core, ['read_file', 'replace', 'write_file', 'glob', 'grep_search', 'list_directory']);
  assert.deepEqual(s.tools.core, GEMINI_CORE_TOOLS);
  for (const banned of ['run_shell_command', 'web_fetch', 'google_web_search', 'activate_skill']) {
    assert.ok(!s.tools.core.includes(banned), banned);
  }
  assert.deepEqual(Object.keys(s.mcpServers), ['pilot']);
});

test('token diet: no narration, no dir tree, no plan/agents, turn cap, skip next-speaker check', async () => {
  const { buildGeminiSettings, GEMINI_MAX_TURNS } = await import('./gemini-setup');
  const s = buildGeminiSettings('m');
  assert.equal(s.general.topicUpdateNarration, false);
  assert.equal(s.context.includeDirectoryTree, false);
  assert.equal(s.general.plan.enabled, false);
  assert.equal(s.experimental.enableAgents, false);
  assert.equal(s.model.maxSessionTurns, GEMINI_MAX_TURNS);
  assert.equal(GEMINI_MAX_TURNS, 16);
  assert.equal(s.model.skipNextSpeakerCheck, true);
  assert.equal(s.privacy.usageStatisticsEnabled, false);
});

test('model aliases force LOW thinking on the gemini-3 base and pin the configured model', async () => {
  const { buildGeminiSettings } = await import('./gemini-setup');
  const aliases = buildGeminiSettings('gemini-x').modelConfigs.aliases as Record<string, {
    extends: string;
    modelConfig: Record<string, unknown>;
  }>;
  assert.equal(aliases['chat-base-3'].extends, 'chat-base');
  assert.deepEqual(aliases['chat-base-3'].modelConfig, {
    generateContentConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
  });
  assert.equal(aliases['gemini-x'].extends, 'chat-base-3');
  assert.deepEqual(aliases['gemini-x'].modelConfig, { model: 'gemini-x' });
  assert.equal(Object.keys(aliases).length, 2);
});

test('writeGeminiRuntime writes the deny policy + settings under the isolated home', async () => {
  const mod = await import('./gemini-setup');
  const logs: string[] = [];
  mod.writeGeminiRuntime((m) => logs.push(m));
  assert.equal(mod.GEMINI_HOME, join(ws, '.gemini-home'));
  assert.equal(mod.GEMINI_POLICY_PATH, join(ws, '.gemini-home', '.gemini', 'policies', 'content-pilot-lockdown.toml'));
  const policy = readFileSync(mod.GEMINI_POLICY_PATH, 'utf8');
  assert.match(policy, /toolName = \["run_shell_command", "web_fetch", "google_web_search"\]\ndecision = "deny"/);
  assert.ok(
    policy.includes(`toolName = ["read_file", "read_many_files"]\nargsPattern = '\\.(webp|jpe?g|png|gif|avif)"'\ndecision = "deny"`),
    'image-read deny rule present'
  );
  assert.equal((policy.match(/interactive = false/g) ?? []).length, 2);
  const settings = JSON.parse(readFileSync(join(ws, '.gemini-home', '.gemini', 'settings.json'), 'utf8'));
  assert.deepEqual(settings, mod.buildGeminiSettings('gemini-test-model'));
  assert.deepEqual(logs, [`gemini runtime written (${mod.GEMINI_HOME})`]);
});

test('writeGeminiRuntime is idempotent and never throws — a write failure is logged', async () => {
  const mod = await import('./gemini-setup');
  const logs: string[] = [];
  mod.writeGeminiRuntime((m) => logs.push(m));
  mod.writeGeminiRuntime((m) => logs.push(m));
  assert.equal(logs.length, 2);
  // Make settings.json a directory so writeFileSync fails.
  writeFileSync(mod.GEMINI_POLICY_PATH, 'tampered');
  const { rmSync, mkdirSync } = await import('fs');
  rmSync(join(mod.GEMINI_HOME, '.gemini', 'settings.json'));
  mkdirSync(join(mod.GEMINI_HOME, '.gemini', 'settings.json'));
  const failLogs: string[] = [];
  assert.doesNotThrow(() => mod.writeGeminiRuntime((m) => failLogs.push(m)));
  assert.equal(failLogs.length, 1);
  assert.match(failLogs[0], /^gemini runtime write failed: /);
  // Policy was rewritten before the failure (policy first, settings second).
  assert.notEqual(readFileSync(mod.GEMINI_POLICY_PATH, 'utf8'), 'tampered');
});

test('gemini settings register the pilot replace tool as a trusted stdio MCP server', async () => {
  const { buildGeminiSettings } = await import('./gemini-setup');
  const settings = buildGeminiSettings('gemini-3.1-flash-lite', '/srv/app');
  assert.deepEqual(settings.mcpServers.pilot, {
    command: '/srv/app/node_modules/.bin/tsx',
    args: ['/srv/app/src/preview/replace-mcp-server.ts'],
    trust: true,
    timeout: 30_000,
  });
});
