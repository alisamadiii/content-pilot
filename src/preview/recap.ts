import { sanitize } from '../worker/git';

// Pure helpers for chat.ts, kept DB-free so they can be unit-tested without
// a DATABASE_URL (importing @/db throws when it is unset).

export const RECAP_MAX_MESSAGES = 12;
const RECAP_MSG_CHARS = 400;
const RECAP_TOTAL_CHARS = 4000;

export type RecapRow = {
  role: 'user' | 'assistant';
  content: string;
  status: string;
  error: string | null;
};

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Compact transcript recap for a fresh Claude run after the CLI-side
 * conversation was lost (stale --resume target). The DB transcript is the
 * durable history; this replays it into the prompt so the model doesn't
 * greet the client as a stranger mid-conversation.
 */
export const renderRecap = (rows: RecapRow[]): string | null => {
  const lines = rows.map((row) => {
    const who = row.role === 'user' ? 'Client' : 'You';
    let line = `${who}: ${truncate(row.content.replace(/\s+/g, ' ').trim(), RECAP_MSG_CHARS)}`;
    if (
      row.role === 'user' &&
      (row.status === 'failed' || row.status === 'rejected')
    ) {
      const why = row.error ? `: ${truncate(row.error.replace(/\s+/g, ' ').trim(), RECAP_MSG_CHARS)}` : '';
      line += `\n[that request was not applied${why}]`;
    }
    return line;
  });
  // Oldest exchanges drop first when over budget.
  while (lines.length && lines.join('\n').length > RECAP_TOTAL_CHARS) {
    lines.shift();
  }
  if (!lines.length) return null;
  return `Context recovery: our previous chat history in this editing session was lost due to a technical restart. Below is a recap of the conversation so far. These exchanges already happened — do not redo changes that already succeeded.

${lines.join('\n')}

End of recap. Continue the conversation naturally with the client's next message below.`;
};

/**
 * Client-safe error text: the substantive error stays verbatim (the site
 * owner asked to see the real message), but infra internals — worktree
 * paths, loopback host:port, credentials — are stripped first.
 */
export const sanitizeForClient = (text: string, dir: string) =>
  sanitize(text)
    .split(dir)
    .join('')
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, 'the preview server')
    .replace(/\s+/g, ' ')
    .trim();
