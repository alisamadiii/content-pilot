/**
 * Dev tool: build the exact Gemini prompt the supervisor would build for one
 * chat message against a workspace clone, run the CLI headlessly with the
 * same runtime (settings, policy, system prompt), and report tokens, tool
 * calls and wall time. No DB, no dev server, no commit — the clone's working
 * tree may be modified by the model; `git checkout .` afterwards.
 *
 *   pnpm exec tsx scripts/gemini-probe.ts <repoId> "<message>" [pageUrl]
 *   DRY=1 … prints the prompt instead of running.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../src/worker/config';
import { previewConfig } from '../src/preview/config';
import { buildRepoContext } from '../src/preview/repo-context';
import { writeGeminiSystemPrompt } from '../src/preview/gemini-system-prompt';
import { buildPinnedFile } from '../src/preview/prompt-context';
import {
  GEMINI_HOME,
  GEMINI_POLICY_PATH,
  writeGeminiRuntime,
} from '../src/preview/gemini-setup';
import {
  bareSkillRequest,
  buildSkillBlock,
  loadSkill,
  parseSkillInvocation,
} from '../src/preview/skills';
import { chooseImageDir, listImageDirHints, publicRelFor, slugify } from '../src/preview/image-dirs';
import { mkdir, writeFile } from 'fs/promises';

const [repoId, message, pageUrl = 'http://x.localhost:3020/'] = process.argv.slice(2);
if (!repoId || !message) {
  console.error('usage: tsx scripts/gemini-probe.ts <repoId> "<message>" [pageUrl]');
  process.exit(2);
}
// A repo id under WORKSPACE_DIR, or an absolute path to any local clone.
const dir = repoId.startsWith('/') ? repoId : join(config.workspaceDir, repoId);
const appDir = dir;

const main = async () => {
  writeGeminiRuntime((m) => console.error('[setup]', m));
  console.error(`[probe] model ${previewConfig.geminiModel}, clone ${dir}`);
  const repo = await buildRepoContext(dir, appDir);
  const systemPromptPath = await writeGeminiSystemPrompt('probe', repo);
  const context = `The client is editing this page: ${pageUrl}`;
  let skillBlock = '';
  let request = message;
  const invocation = parseSkillInvocation(message);
  if (invocation) {
    const skill = await loadSkill(dir, appDir, invocation.name);
    if (skill) {
      skillBlock = buildSkillBlock(skill, invocation.rest);
      request = invocation.rest || bareSkillRequest(skill.name);
    }
  }
  // Mirrors chat.ts: a skill names its own files, so no page pin with it.
  const pinned = skillBlock
    ? ''
    : await buildPinnedFile(context, dir, appDir, {
        message,
        routes: repo.routes,
        hasAttachments: Boolean(process.env.IMAGE),
      });
  // IMAGE="<description>": simulate one uploaded image the way chat.ts +
  // attachments.ts would (server-chosen path, placeholder bytes, prompt block).
  let attachBlock = '';
  if (process.env.IMAGE) {
    const publicRel = publicRelFor(dir, appDir);
    const hints = await listImageDirHints(appDir, publicRel);
    const folder = chooseImageDir(process.env.IMAGE, hints, publicRel);
    const dest = `${folder}/${slugify(process.env.IMAGE)}.webp`;
    await mkdir(join(dir, folder), { recursive: true });
    await writeFile(join(dir, dest), 'RIFF....WEBP');
    const url = '/' + dest.slice(publicRel.length + 1);
    attachBlock = [
      'Uploaded images',
      '',
      'The site owner attached 1 image to this request. The server has already saved it into the site at the URL path below. Do NOT open, read, view or search for image files. Everything you need is here.',
      '',
      `1. \`${url}\` (webp, 1200 x 800). Description: ${process.env.IMAGE}`,
      '',
      `Reference each image by that exact URL path in the component or CMS JSON, for example <img src="${url}" alt="..."> or the matching JSON field. Use the description for the alt text. If the request does not say where an image goes, put it where the description suggests and tell the owner where it now appears.`,
    ].join('\n');
    console.error(`[probe] image placed at ${dest}`);
  }
  const prompt =
    [context, pinned, attachBlock, skillBlock].filter(Boolean).join('\n\n') +
    `\n\n---\n\n${request}`;
  const systemPrompt = await readFile(systemPromptPath, 'utf8');
  console.error(
    `[probe] system prompt ${systemPrompt.length} chars; user prompt ${prompt.length} chars; pinned=${pinned ? 'yes' : 'no'} skill=${skillBlock ? 'yes' : 'no'}`
  );
  if (process.env.DRY) {
    console.log(prompt);
    return;
  }
  const args = [
    '-m',
    previewConfig.geminiModel,
    '--approval-mode',
    'auto_edit',
    '--output-format',
    'stream-json',
  ];
  if (existsSync(GEMINI_POLICY_PATH)) args.push('--admin-policy', GEMINI_POLICY_PATH);
  const child = spawn('gemini', args, {
    cwd: dir,
    env: {
      ...process.env,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_CLI_HOME: GEMINI_HOME,
      GEMINI_SYSTEM_MD: systemPromptPath,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(prompt);
  child.stdin.end();
  let buf = '';
  const started = Date.now();
  const tools: string[] = [];
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'tool_use') {
          tools.push(`${evt.tool_name}(${JSON.stringify(evt.parameters ?? {}).slice(0, 100)})`);
        } else if (evt.type === 'message' && evt.role === 'assistant') {
          text += evt.content ?? '';
        } else if (evt.type === 'result') {
          console.log('[result]', JSON.stringify(evt.stats ?? evt).slice(0, 800));
        } else if (evt.type === 'error') {
          console.log('[error]', JSON.stringify(evt).slice(0, 300));
        }
      } catch {
        console.log('[raw]', line.slice(0, 200));
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
  const code = await new Promise<number>((resolve) =>
    child.on('close', (c) => resolve(c ?? 0))
  );
  console.log(
    `[done] exit=${code} ${((Date.now() - started) / 1000).toFixed(1)}s tools=${tools.length}`
  );
  for (const t of tools) console.log('  tool:', t);
  console.log('[reply]', text.trim().slice(0, 400));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
