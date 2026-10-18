import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { findSessionForbiddenPaths } from '../worker/guardrails';

/**
 * One-call literal find/replace across the clone — the agent's tool for "the
 * same value in several files" (a brand hex, a font name, a phone number).
 * Without it the model greps, then Reads and Edits every hit one by one: five
 * full-file reads for a colour swap. Exposed to Claude as an in-process SDK
 * MCP tool and to Gemini over stdio (replace-mcp-server.ts); both call this.
 *
 * Literal and case-sensitive on purpose — a regex tool invites "fix" edits
 * the owner never asked for. Caps refuse (no edits at all) rather than
 * partially apply: the model gets the reason back and narrows the request.
 */

export type ReplaceResult =
  | {
      ok: true;
      files: Array<{ path: string; count: number }>;
      total: number;
      /** Occurrences left alone because they sit inside paths/URLs/keys. */
      skippedIdentifiers?: number;
    }
  | { ok: false; error: string };

export const MIN_FIND_LENGTH = 3;
export const MAX_FILES = 40;
export const MAX_PER_FILE = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', '.next', '.vercel', '.output', 'build']);
/**
 * Developer-facing files the owner never means by "everywhere": agent
 * skills/notes, legacy CMS config, docs, email templates, config. (EmpowerHer
 * 2026-10-18: "rename Mentorship to Mentoring everywhere" rewrote
 * .claude/skills, AGENTS.md, cms/*.yml and src/emails.)
 */
export const DEVELOPER_FILE = /(^|\/)(\.claude|\.agents|\.gemini|\.github|cms|docs|scripts|src\/emails?)\/|(^|\/)(AGENTS|CLAUDE|README|HANDOVER|CLIENT-HANDOFF)\.md$|\.(ya?ml|toml|config\.(m?js|ts)|d\.ts)$/i;
const BINARY_EXT = /\.(webp|jpe?g|png|gif|avif|ico|svg|woff2?|ttf|otf|eot|pdf|zip|gz|mp[34]|webm|mov|lock)$/i;

const looksBinary = (buf: Buffer) => {
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return true;
  return false;
};

const walk = (root: string, dir: string, out: string[]) => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(root, full, out);
    } else if (stat.isFile() && stat.size <= MAX_FILE_BYTES && !BINARY_EXT.test(name)) {
      out.push(relative(root, full).split('\\').join('/'));
    }
  }
};

/**
 * An occurrence glued to an identifier/path/key is code, not copy:
 * `/mentorship`, `mentorship-hero.jpeg`, `mentorship.astro`, `"mentorship":`,
 * `{mentorship}`. Replacing those breaks routes, assets and data keys, so a
 * prose rename leaves them alone (the owner can ask for a path change
 * explicitly, which the agent edits by hand).
 */
export const isIdentifierContext = (haystack: string, index: number, length: number) => {
  const before = index > 0 ? haystack[index - 1]! : '';
  const after = index + length < haystack.length ? haystack[index + length]! : '';
  if (/[\/._\-@#$]/.test(before) || /[\/._\-]/.test(after)) return true;
  // JSON / object key: `"mentorship":` or `mentorship:` right after a quote
  if (/^["']?\s*:/.test(haystack.slice(index + length, index + length + 3)) && /["'{,\s]/.test(before || ' ')) return true;
  // Inside an attribute value that is a URL/path: href="/x/mentorship/y"
  const lineStart = haystack.lastIndexOf('\n', index) + 1;
  const prefix = haystack.slice(lineStart, index);
  const attr = /(?:href|src|action|to|link|route|url|path|slug|id|key|class|className)\s*[=:]\s*["'`{][^"'`]*$/i;
  if (attr.test(prefix) && !/\s/.test(prefix.slice(prefix.search(/["'`{][^"'`]*$/) + 1))) return true;
  return false;
};

const countOccurrences = (haystack: string, needle: string) => {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

/** Positions of `needle` in `haystack` that are prose (not identifier context). */
export const proseOccurrences = (haystack: string, needle: string): number[] => {
  const out: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (!isIdentifierContext(haystack, index, needle.length)) out.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return out;
};

const replaceAt = (text: string, needle: string, replacement: string, positions: number[]) => {
  let out = '';
  let cursor = 0;
  for (const pos of positions) {
    out += text.slice(cursor, pos) + replacement;
    cursor = pos + needle.length;
  }
  return out + text.slice(cursor);
};

export const replaceInFiles = (params: {
  dir: string;
  find: string;
  replace: string;
  /** Only touch files whose repo-relative path contains one of these. */
  include?: string[];
  /** Count matches without writing. */
  dryRun?: boolean;
}): ReplaceResult => {
  const { dir, find, replace } = params;
  if (find.length < MIN_FIND_LENGTH) {
    return {
      ok: false,
      error: `"find" must be at least ${MIN_FIND_LENGTH} characters — a shorter needle would match far too much.`,
    };
  }
  if (find === replace) {
    return { ok: false, error: '"find" and "replace" are identical — nothing to do.' };
  }
  const include = (params.include ?? []).map((item) => item.trim()).filter(Boolean);

  const candidates: string[] = [];
  walk(dir, dir, candidates);

  const hits: Array<{ path: string; count: number; text: string; positions: number[] }> = [];
  let skippedIdentifiers = 0;
  for (const path of candidates) {
    if (include.length && !include.some((needle) => path.includes(needle))) continue;
    if (findSessionForbiddenPaths([path]).length) continue;
    if (DEVELOPER_FILE.test(path)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(join(dir, path));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const text = buf.toString('utf8');
    const positions = proseOccurrences(text, find);
    const count = positions.length;
    skippedIdentifiers += countOccurrences(text, find) - count;
    if (!count) continue;
    if (count > MAX_PER_FILE) {
      return {
        ok: false,
        error: `"${find}" appears ${count} times in ${path} — more than ${MAX_PER_FILE}. That is not a brand value; edit that file directly instead.`,
      };
    }
    hits.push({ path, count, text, positions });
  }

  if (hits.length > MAX_FILES) {
    return {
      ok: false,
      error: `"${find}" appears in ${hits.length} files — more than ${MAX_FILES}. Narrow it with "include" (e.g. ["src/components"]) or pick a more specific string.`,
    };
  }

  if (!params.dryRun) {
    for (const hit of hits) {
      writeFileSync(join(dir, hit.path), replaceAt(hit.text, find, replace, hit.positions));
    }
  }
  const files = hits.map(({ path, count }) => ({ path, count }));
  return { ok: true, files, total: files.reduce((sum, file) => sum + file.count, 0), skippedIdentifiers };
};

/** The text the model reads back — short, lists every touched file. */
export const describeReplace = (result: ReplaceResult): string => {
  if (!result.ok) return `No changes made. ${result.error}`;
  const skipped = result.skippedIdentifiers
    ? ` Left ${result.skippedIdentifiers} occurrence${result.skippedIdentifiers === 1 ? '' : 's'} inside links, file names or data keys unchanged on purpose (routes and assets keep their names). Do not edit those by hand.`
    : '';
  if (!result.files.length) {
    return result.skippedIdentifiers
      ? `No prose contains that text. Nothing changed.${skipped}`
      : 'No files contain that text. Nothing changed.';
  }
  const lines = result.files.map((file) => `- ${file.path} (${file.count})`);
  return `Replaced ${result.total} occurrence${result.total === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}:\n${lines.join('\n')}${skipped ? `\n${skipped.trim()}` : ''}`;
};

export const REPLACE_TOOL_DESCRIPTION =
  'Replace every occurrence of a literal string across the site in one call (brand colours, fonts, phone numbers, business names). Case-sensitive, not a regex. Use this instead of reading and editing files one by one when the same value appears in several files. Refuses needles under 3 characters, more than 40 files, or more than 200 hits in one file — narrow with "include" (path fragments like "src/components") if that happens. Returns the files and counts it changed.';
