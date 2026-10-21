import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';

/**
 * Client-repo skills (`<skills dir>/<name>/SKILL.md`), invoked from the hub
 * chat as a message starting with `/<name>`. Claude's harness expands those
 * itself (`skills: 'all'` + project settings). Gemini CLI would discover
 * `.gemini/skills` through its `activate_skill` tool — one extra model turn
 * per invocation plus the skill catalog in every request — so for Gemini the
 * supervisor inlines the skill body into the prompt instead and the tool stays
 * out of the set. Lookup is repo root only, in order `.claude`, `.gemini`,
 * `.agents`.
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
  name: string
): Promise<LoadedSkill | null> => {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
  for (const skillDir of SKILL_DIRS) {
    const folder = join(dir, skillDir, 'skills', name);
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
    `Reply as the website editor talking to the person who runs this site: plain words, second person, no technical terms, no file names. No greeting or preamble — lead with the answer. Never say "the site owner", "invoked", "skill" or "/${skill.name}". If you need something they have not told you (which item, what text, which page), ask for just that in one short question and make no edits yet.`,
    '',
    `--- skill: ${skill.name} ---`,
    skill.body,
    `--- end of skill ---`,
  ].join('\n');

/**
 * The details message after a bare `/name` (the model asked "what would you
 * like to do?" and this is the answer) belongs to that skill. Gemini runs
 * every message as a fresh conversation, so without this the follow-up runs
 * with no skill text at all (EmpowerHer 2026-10-18: `/manage-resources` →
 * question → details → two reads, no edit). Only a BARE previous invocation
 * carries over; a completed `/name details` turn does not re-arm the skill.
 */
export const carrySkillFromPrevious = (
  previousUserContent: string | null | undefined,
  content: string
): SkillInvocation | null => {
  if (!previousUserContent) return null;
  if (parseSkillInvocation(content)) return null;
  const previous = parseSkillInvocation(previousUserContent);
  if (!previous || previous.rest) return null;
  const rest = content.trim();
  if (!rest) return null;
  return { name: previous.name, rest };
};

/** The user-turn text for a bare `/name` with nothing after it. */
export const bareSkillRequest = (name: string) =>
  `(They clicked /${name} without adding any details. Do not read or change any file yet: first ask them, in one short question with no greeting or preamble, what they would like to do — which item, what text, which page — and stop there. Only skip the question if the skill can be completed with no input at all.)`;

/**
 * Client-facing reply scrub. Flash-lite sometimes echoes prompt framing
 * ("using the `/add-page` skill") despite instructions; strip the skill
 * token and backticks so no prompt jargon reaches the chat bubble.
 */
export const scrubSkillJargon = (text: string, skillName: string | null) => {
  let out = text.replace(/`/g, '');
  if (skillName) {
    const name = skillName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out
      .replace(new RegExp(`\\s*(?:using|with|via|through|by running)\\s+the\\s+/?${name}\\s+skill`, 'gi'), '')
      .replace(
        new RegExp(`\\s*(?:\\b(?:with|using|via|through)\\s+)?\\(?/${name}\\)?`, 'gi'),
        ''
      );
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
};

// ---------------------------------------------------------------------------
// Catalog for the hub's "/" menu (used by the skills API route).
// ---------------------------------------------------------------------------

export type SkillInfo = { name: string; description: string };

/**
 * Minimal SKILL.md frontmatter reader — just `name:` and `description:`
 * between the first `---` pair. Skills are authored by us in client repos, so
 * a full YAML parser is overkill; anything unparseable is skipped.
 */
export const parseSkillFrontmatter = (raw: string): SkillInfo | null => {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!fields.name) return null;
  return { name: fields.name, description: fields.description ?? '' };
};

/** Every `<base>/.claude/skills/<entry>/SKILL.md` with valid frontmatter. */
export const scanSkillsDir = async (base: string): Promise<SkillInfo[]> => {
  const skillsDir = join(base, '.claude', 'skills');
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }
  const found: SkillInfo[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      raw = await readFile(join(skillsDir, entry, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const skill = parseSkillFrontmatter(raw);
    if (skill) found.push(skill);
  }
  return found;
};

/** Catalog for a clone: the repo root's `.claude/skills/`, sorted by name. */
export const listSkills = async (dir: string): Promise<SkillInfo[]> => {
  const skills = new Map<string, SkillInfo>();
  for (const skill of await scanSkillsDir(dir)) {
    skills.set(skill.name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
};
