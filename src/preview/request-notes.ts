import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

/**
 * Zero-AI pre-run notes derived from the repo and the message. Each one is a
 * sentence or two prepended to the request so flash-lite does not have to
 * discover (or guess) what the server already knows. Found in EmpowerHer
 * break-testing 2026-10-18:
 *
 *  - "Move the AGFAF partner logo to the top": the model never opened
 *    partners.json and claimed it was already at the top. → `collectionHints`
 *    names the collection file an entry lives in (order = array position).
 *  - "/manage-team add Mahdi Rahimi …" for an existing member: the model
 *    overwrote his real photo. → `duplicateNote` says the entry exists and
 *    tells the model to ask instead of adding or editing.
 *  - "Rename Mentorship to Mentoring everywhere": only the current page's
 *    files changed. → `siteWideNote`.
 *  - A story with no date got a guessed one (the skill wants today's date
 *    from a shell the editor does not have). → `todayLine`.
 */

export type CollectionEntryHit = { label: string; file: string; index: number; count: number };

const MAX_COLLECTION_BYTES = 400_000;
const MIN_LABEL_LENGTH = 4;
const LABEL_KEYS = ['name', 'title'];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Entries of `_collections/*.json` arrays whose name/title appears in the
 * message (whole words, case-insensitive). Longest labels first so
 * "Right to Learn Afghanistan" beats "Afghanistan"-only partial hits.
 */
export const findCollectionEntries = async (
  dir: string,
  message: string
): Promise<CollectionEntryHit[]> => {
  const folder = join(dir, '_collections');
  let names: string[] = [];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const hits: CollectionEntryHit[] = [];
  for (const name of names) {
    const file = `_collections/${name}`;
    try {
      const info = await stat(join(dir, file));
      if (info.size > MAX_COLLECTION_BYTES) continue;
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) continue;
      parsed.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        for (const key of LABEL_KEYS) {
          const label = (entry as Record<string, unknown>)[key];
          if (typeof label !== 'string' || label.trim().length < MIN_LABEL_LENGTH) continue;
          const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(label.trim())}(?![\\p{L}\\p{N}])`, 'iu');
          if (re.test(message)) {
            hits.push({ label: label.trim(), file, index, count: parsed.length });
            break;
          }
        }
      });
    } catch {
      // unreadable / invalid JSON — the post-edit check reports those
    }
  }
  return hits.sort((a, b) => b.label.length - a.label.length);
};

const ADD_INTENT = /\b(add|adding|create|new|insert|include)\b/i;
const CHANGE_INTENT = /\b(update|change|edit|replace|remove|delete|rename|move|reorder|swap|fix)\b/i;

/** One line per matched entry: where it lives and that order is position. */
export const collectionHints = (hits: CollectionEntryHit[]): string => {
  if (!hits.length) return '';
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const hit of hits) {
    const key = `${hit.file}:${hit.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `- "${hit.label}" is entry ${hit.index + 1} of ${hit.count} in ${hit.file} (array order = display order; edit that file for anything about it).`
    );
    if (lines.length >= 4) break;
  }
  return `Known content entries mentioned in this request:\n${lines.join('\n')}`;
};

/**
 * "add X" where X already exists in a collection: say so and ask; never add a
 * duplicate or silently edit the existing one. Skipped when the message also
 * reads as an update/remove (the hint above still names the file).
 */
export const duplicateNote = (message: string, hits: CollectionEntryHit[]): string => {
  if (!hits.length || !ADD_INTENT.test(message) || CHANGE_INTENT.test(message.replace(ADD_INTENT, ''))) return '';
  const hit = hits[0]!;
  return `Note: an entry named "${hit.label}" already exists in ${hit.file}. Do NOT add a duplicate and do NOT change the existing entry: tell the owner it is already there and ask whether they want to update it with these details or add it a second time.`;
};

const SITE_WIDE = /\b(everywhere|across the (?:whole |entire )?(?:site|website)|site-?wide|on (?:all|every) pages?|(?:whole|entire) (?:site|website)|all over the site)\b/i;

/** "everywhere" means every file, not the current page. */
export const siteWideNote = (message: string): string =>
  SITE_WIDE.test(message)
    ? 'The owner said everywhere: this applies to every file in the site, not only the page being viewed. Use replace_in_files once per exact text (and once for its lower-case form if it occurs) instead of editing files one by one, then report how many files changed.'
    : '';

/** Real date for the editor (no shell): "Today is 2026-10-18." */
export const todayLine = (now: Date = new Date()): string =>
  `Today is ${now.toISOString().slice(0, 10)}. Use this exact date wherever a date defaults to today.`;
