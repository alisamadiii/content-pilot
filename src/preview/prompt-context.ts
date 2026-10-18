import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  collectPageBundle,
  resolvePageFile,
  routeMentionedIn,
} from './repo-context';

/**
 * Parses the element source ref the hub embeds in a message context when the
 * client clicks an element: `source: <path>:<line>`. The `data-cms-src` value
 * may be `<project>:src/…:line`, so a leading project segment (with no slash)
 * is dropped and the trailing `:line` is split off. Returns null when there is
 * no ref or the path escapes the repo.
 */
export const parseSourceRef = (
  context: string | null
): { path: string; line: number | null } | null => {
  if (!context) return null;
  const match = context.match(/source:\s*(\S+)/);
  if (!match) return null;
  const ref = match[1];
  const lineMatch = ref.match(/^(.*):(\d+)$/);
  const line = lineMatch ? Number(lineMatch[2]) : null;
  let path = lineMatch ? lineMatch[1] : ref;
  // Drop a leading `<project>:` prefix so the remainder is a repo-relative path.
  if (path.includes(':')) {
    const [, ...rest] = path.split(':');
    if (rest.length) path = rest.join(':');
  }
  if (!path || path.includes('..')) return null;
  return { path, line };
};

/** The page the client is viewing, from the hub-supplied message context. */
export const pagePathFromContext = (context: string | null): string => {
  const match = context?.match(/editing this page: (\S+)/);
  if (!match) return '/';
  try {
    return new URL(match[1]).pathname || '/';
  } catch {
    return match[1].startsWith('/') ? match[1] : '/';
  }
};

export const MAX_PINNED_FILE_BYTES = 40_000;

// Cheap edit-intent check (no AI call). Pinning a page bundle costs ~10k
// tokens, right for an edit and waste for chat ("did you read it?"). A miss
// is soft: the page map is in the system prompt, so the model reads the file
// itself at the cost of one extra turn. Keep the net wide.
const EDIT_WORDS = [
  'change', 'add', 'remove', 'delete', 'update', 'make', 'put', 'replace',
  'set', 'edit', 'fix', 'swap', 'rename', 'move', 'insert', 'upload',
  'shorten', 'lengthen', 'rewrite', 'write', 'show', 'hide', 'switch',
  'translate', 'bold', 'link', 'bigger', 'smaller', 'larger', 'increase',
  'reduce', 'new', 'use',
  // corrections
  'typo', 'wrong', 'should', 'instead', 'missing', 'outdated', 'broken',
  'incorrect',
];
const EDIT_WORD_RE = new RegExp(`\\b(${EDIT_WORDS.join('|')})\\b`, 'i');
const QUOTED_RE = /["“”'‘’][^"“”'‘’]{2,}["“”'‘’]/;

/** True when the message reads like a request to change something. */
export const looksLikeEdit = (message: string, hasAttachments = false) =>
  hasAttachments || EDIT_WORD_RE.test(message) || QUOTED_RE.test(message);

const fence = (path: string, content: string) =>
  `### ${path}\n\`\`\`\n${content}\n\`\`\``;

/**
 * Inline the file(s) the request is about so the AI edits with the content in
 * hand instead of reading and grepping (flash-lite over-explores otherwise: a
 * one-value change hit 250k tokens). content-pilot has free filesystem access,
 * so the read costs no AI tokens.
 *
 * Two sources, in priority order:
 *  1. The clicked element's file (`source: path:line` in the hub context).
 *  2. The page: one the message names ("the about page") or else the page the
 *     client is viewing, resolved through the repo's route map, plus the
 *     content components it imports (pages are often just a list of sections).
 *
 * Skips files too large to inline (the AI reads those the normal way). Returns
 * '' when nothing can be pinned.
 */
export type PinnedContext = {
  /** The prompt block ('' when nothing is pinned). */
  text: string;
  /** The pinned files (clicked file, or page + imported components). */
  files: Array<{ path: string; content: string }>;
  /** True when the owner clicked an element (pick-mode) — unambiguous target. */
  picked: boolean;
  /** The page route the pin is about (null for a clicked file / no pin). */
  route: string | null;
};

const NOTHING: PinnedContext = { text: '', files: [], picked: false, route: null };

export const buildPinnedFile = async (
  context: string | null,
  dir: string,
  appDir: string,
  options: {
    message?: string;
    routes?: Map<string, string>;
    hasAttachments?: boolean;
  } = {}
): Promise<string> => (await collectPinned(context, dir, appDir, options)).text;

/** buildPinnedFile plus the underlying files, for pre-run checks (ambiguity). */
export const collectPinned = async (
  context: string | null,
  dir: string,
  appDir: string,
  options: {
    message?: string;
    routes?: Map<string, string>;
    hasAttachments?: boolean;
  } = {}
): Promise<PinnedContext> => {
  const ref = parseSourceRef(context);
  if (ref) {
    for (const file of [join(appDir, ref.path), join(dir, ref.path)]) {
      try {
        const content = await readFile(file, 'utf8');
        if (content.length > MAX_PINNED_FILE_BYTES) return NOTHING;
        const text =
          `The client clicked an element in \`${ref.path}\`` +
          (ref.line ? ` (their element is at line ${ref.line})` : '') +
          `. The full current content of that file is below — you already have ` +
          `it, so make the change by editing THIS file. Do not read it again, ` +
          `do not search the repo, do not run commands.\n\n` +
          '```\n' +
          content +
          '\n```';
        return { text, files: [{ path: ref.path, content }], picked: true, route: null };
      } catch {
        // try the next candidate path
      }
    }
    return NOTHING;
  }

  const routes = options.routes;
  if (!routes?.size) return NOTHING;
  const message = options.message ?? '';
  const current = pagePathFromContext(context);
  const mentioned = routeMentionedIn(message, routes, current);
  // Chat ("hi", "did you read it?") gets no pin; naming a page or sounding
  // like an edit does.
  if (!mentioned && !looksLikeEdit(message, options.hasAttachments)) return NOTHING;
  const route = mentioned ?? current;
  const pageFile = resolvePageFile(routes, route);
  if (!pageFile) return NOTHING;
  const bundle = await collectPageBundle(dir, appDir, pageFile, MAX_PINNED_FILE_BYTES);
  if (!bundle) return NOTHING;
  const who = mentioned ? 'The request is about' : 'The client is viewing';
  const parts = [
    `${who} the page \`${route}\`, rendered by \`${pageFile}\`. The full current content of that file` +
      (bundle.files.length > 1 ? ' and the components it imports' : '') +
      ` is below — you already have ${bundle.files.length > 1 ? 'them' : 'it'}, so make the change by editing ` +
      `${bundle.files.length > 1 ? 'THESE files' : 'THIS file'}. Do not read ${bundle.files.length > 1 ? 'them' : 'it'} again, do not search the repo, do not run commands.` +
      (bundle.omitted.length
        ? ` Also imported but not shown (read only if the content you need is not below): ${bundle.omitted.map((f) => `\`${f}\``).join(', ')}.`
        : ' If the content you need is not below, read only the one extra file you need.'),
    ...bundle.files.map((f) => fence(f.path, f.content)),
  ];
  return { text: parts.join('\n\n'), files: bundle.files, picked: false, route };
};

/**
 * Whether an agent run failed because its --resume target is gone (container
 * recreated, CLI state pruned). Provider-agnostic: Claude says "no conversation
 * found"; Gemini says "Error resuming session: No previous sessions found for
 * this project." Matches the `resum` stem plus common not-found/invalid
 * phrasings around session/conversation/checkpoint.
 */
export const isStaleResumeError = (stderr: string): boolean =>
  /resum|checkpoint|no (previous )?(conversation|session)|(session|conversation|chat)s?.*(not found|no longer|invalid|unknown|expired|does ?n.t exist)/i.test(
    stderr
  );
