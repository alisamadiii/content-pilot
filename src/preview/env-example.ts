import { readFileSync } from 'fs';
import { join } from 'path';

// The client repo's `.env.example` is the contract for which env variables the
// owner may set for the live preview (values live encrypted in app_setting,
// see getProjectEnv). Pure parsing + merge rules, unit-tested without a DB.

export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export type EnvExampleEntry = {
  key: string;
  /** The `#` comment lines directly above the key, joined with a space. */
  description: string;
  /** The placeholder value from the file (quotes and inline comment removed). */
  example: string;
};

const ASSIGNMENT = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/;

const exampleValue = (raw: string) => {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    // Unterminated quote: keep what follows the opening quote.
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  // Unquoted: `#` starts a comment only at the start or after whitespace, so
  // values like `https://x.dev/#a` survive.
  return value.replace(/(^|\s+)#.*$/, '').trim();
};

/**
 * Parses `.env.example` text into its variables, in file order. Lines are
 * `KEY=value` with an optional `export ` prefix; the description is the run of
 * `#` comment lines immediately above (a blank or any other line resets it).
 * Duplicate keys keep the first; keys outside ENV_KEY_PATTERN are skipped.
 */
export const parseEnvExample = (text: string): EnvExampleEntry[] => {
  const entries: EnvExampleEntry[] = [];
  const seen = new Set<string>();
  let comments: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      const comment = line.replace(/^#+/, '').trim();
      if (comment) comments.push(comment);
      continue;
    }
    const match = line.match(ASSIGNMENT);
    const description = comments.join(' ');
    comments = [];
    if (!match) continue;
    const key = match[1];
    if (!ENV_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, description, example: exampleValue(match[2]) });
  }
  return entries;
};

/** The clone's `.env.example` (repo root), or [] when there is none. */
export const readEnvExample = (dir: string): EnvExampleEntry[] => {
  let text: string;
  try {
    text = readFileSync(join(dir, '.env.example'), 'utf8');
  } catch {
    return [];
  }
  return parseEnvExample(text);
};

/**
 * The stored project values a dev server may receive: only keys the clone's
 * `.env.example` still lists (a removed variable stops being passed), and never
 * a `reserved` key — the pilot's own env (NODE_ENV, PATH, HMR ports…) wins.
 * Empty values are dropped.
 */
export const projectDevEnv = (
  allowedKeys: Iterable<string>,
  stored: Record<string, string>,
  reserved: Iterable<string>
): Record<string, string> => {
  const allowed = new Set(allowedKeys);
  const blocked = new Set(reserved);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!value || !allowed.has(key) || blocked.has(key)) continue;
    env[key] = value;
  }
  return env;
};
