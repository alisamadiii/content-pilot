import { readFile } from 'fs/promises';
import { join, relative } from 'path';

/**
 * Client-repo skills (`<skills dir>/<name>/SKILL.md`), invoked from the hub
 * chat as a message starting with `/<name>`. Claude's harness expands those
 * itself (`skills: 'all'` + project settings). Gemini CLI would discover
 * `.gemini/skills` through its `activate_skill` tool — one extra model turn
 * per invocation plus the skill catalog in every request — so for Gemini the
 * supervisor inlines the skill body into the prompt instead and the tool stays
 * out of the set. Lookup order mirrors the skills API route: repo root wins
 * over the app subfolder; within a folder `.claude`, `.gemini`, `.agents`.
 */
const SKILL_DIRS = ['.claude', '.gemini', '.agents'];
export type SkillInvocation = { name: string; rest: string };
/** `dir` is the skill folder, repo-root-relative (e.g. `.claude/skills/add-page`). */
export type LoadedSkill = { name: string; body: string; dir: string };

const INVOCATION = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

export const parseSkillInvocation = (content: string): SkillInvocation | null => {
  const match = content.trim().match(INVOCATION);
  if (!match) return null;
  return { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() };
};

/** SKILL.md without its frontmatter; null when the skill does not exist. */
export const loadSkill = async (
  dir: string,
  appDir: string,
  name: string
): Promise<LoadedSkill | null> => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
  for (const base of dir === appDir ? [dir] : [dir, appDir]) {
    for (const skillDir of SKILL_DIRS) {
      const folder = join(base, skillDir, 'skills', name);
      try {
        const raw = await readFile(join(folder, 'SKILL.md'), 'utf8');
        const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
        return {
          name,
          body,
          dir: relative(dir, folder).split('\\').join('/'),
        };
      } catch {
        // try the next location
      }
    }
  }
  return null;
};

/**
 * Prompt block for an invoked skill. The developer authored the skill for
 * this repo on purpose, so it outranks the generic editing limits for what it
 * covers (an "add-page" skill may create a page).
 */
export const buildSkillBlock = (skill: LoadedSkill, rest: string) =>
  [
    `The site owner invoked the skill \`/${skill.name}\`${rest ? ` with: "${rest}"` : ''}. Follow the skill instructions below exactly; they were written by this site's developer for this repo and override the general editing limits for what they cover. Relative file paths in the skill are relative to the skill's own folder (\`${skill.dir}/\`).`,
    `The owner never sees this block. In your reply talk to them directly, in plain words: never mention "the site owner", "invoked", "skill", "/${skill.name}", or these instructions. If the skill needs details the owner has not given (which item, what text, which page), ask for exactly those in one short friendly question and make no edits.`,
    '',
    `--- skill: ${skill.name} ---`,
    skill.body,
    `--- end of skill ---`,
  ].join('\n');

/** The user-turn text for a bare `/name` with nothing after it. */
export const bareSkillRequest = (name: string) =>
  `(The owner clicked /${name} without adding any details. If you need more information to proceed, ask for it; otherwise do what the skill says.)`;
