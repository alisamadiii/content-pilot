import { readFile } from 'fs/promises';
import { join } from 'path';

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

/**
 * When the client clicked an element, inline the clicked file's full content
 * into the prompt so the AI edits with the whole file in hand instead of
 * reading it 4x and grepping (flash-lite over-explores otherwise: a one-value
 * change hit 250k tokens). content-pilot has free filesystem access, so the
 * read costs no AI tokens. Skips files too large to inline (the AI reads those
 * the normal way). Returns '' when there is no ref or the file can't be read.
 */
export const MAX_PINNED_FILE_BYTES = 40_000;
export const buildPinnedFile = async (
  context: string | null,
  dir: string,
  appDir: string
): Promise<string> => {
  const ref = parseSourceRef(context);
  if (!ref) return '';
  for (const file of [join(appDir, ref.path), join(dir, ref.path)]) {
    try {
      const content = await readFile(file, 'utf8');
      if (content.length > MAX_PINNED_FILE_BYTES) return '';
      return (
        `The client clicked an element in \`${ref.path}\`` +
        (ref.line ? ` (their element is at line ${ref.line})` : '') +
        `. The full current content of that file is below — you already have ` +
        `it, so make the change by editing THIS file. Do not read it again, ` +
        `do not search the repo, do not run commands.\n\n` +
        '```\n' +
        content +
        '\n```'
      );
    } catch {
      // try the next candidate path
    }
  }
  return '';
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
