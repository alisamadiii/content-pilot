import { readFile } from 'fs/promises';
import { join } from 'path';

// Pure helpers behind chat.ts, kept DB-free so they can be unit-tested without
// a DATABASE_URL (importing @/db throws when it is unset).

export const REJECTED_MESSAGE =
  'Thanks for your request! That change touched files the editor must not modify, so it was not applied. Please reach out to your developer and they will be happy to help.';

/** Self-repair attempts when a change breaks the preview before giving up. */
export const MAX_REPAIR_RUNS = 2;

/** Dev-server page probe budget (one probe per edit; a hung server must not stall the pump). */
export const PAGE_PROBE_TIMEOUT_MS = 30_000;

/** Tool calls in a forwarded agent event (both providers use the hub shape). */
export const countToolUses = (event: unknown): number => {
  const message = (event as { type?: string; message?: { content?: unknown } })
    ?.message;
  if ((event as { type?: string })?.type !== 'assistant') return 0;
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (block) => (block as { type?: string })?.type === 'tool_use'
  ).length;
};

export const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Site-wide CMS files feed every page — a break there can miss the viewed page. */
export const touchesSharedCms = (changed: string[]) =>
  changed.some(
    (file) =>
      /(^|\/)(_site|_pages)\.json$/.test(file) || /(^|\/)_collections\//.test(file)
  );

/** First line of the owner's request, capped, as the commit subject. */
export const commitTitle = (content: string) => content.split('\n')[0].slice(0, 72);

/**
 * Post-edit verification: a change must not leave the preview broken. Returns a
 * problem description the agent can act on, or null when the change looks
 * healthy. Two checks: changed .json files must still parse (the CMS contract is
 * JSON — one stray comma 500s every page reading it), and the page the client
 * is viewing must still render on the dev server. Infra noise (timeouts,
 * connection refused) never counts as a problem — only concrete 5xx responses.
 */
export const verifyChanges = async (
  dir: string,
  port: number,
  changed: string[],
  pagePath: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> => {
  for (const file of changed) {
    if (!file.endsWith('.json')) continue;
    try {
      JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch (error) {
      return `${file} is no longer valid JSON: ${(error as Error).message}`;
    }
  }
  const checkPage = async (path: string): Promise<string | null> => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(PAGE_PROBE_TIMEOUT_MS),
      });
      if (res.status >= 500) {
        const body = await res.text().catch(() => '');
        return `GET ${path} now returns ${res.status}. Dev server error: ${stripHtml(body).slice(0, 600)}`;
      }
    } catch {
      // Transient dev-server hiccup (restart, timeout) — don't block the
      // commit on infrastructure noise; only concrete errors trigger a repair.
    }
    return null;
  };
  const problem = await checkPage(pagePath);
  if (problem) return problem;
  // Other routes stay unchecked (known limitation; a full crawl per edit is
  // too slow) — but the home page is probed when shared CMS data changed.
  if (touchesSharedCms(changed) && pagePath !== '/') {
    return checkPage('/');
  }
  return null;
};
