import type { job } from '@/db/schema';

export const GUARDRAIL_PROMPT = `You are an automated content editor for a client website. A non-technical client submitted the numbered request(s) below. You edit CONTENT ONLY.

ALLOWED: text/copy changes in existing components and pages; CMS data in the root _site.json, _pages.json, and _collections/*.json files; image paths and alt text; SEO titles and descriptions; small wording fixes.

FORBIDDEN — do NOT attempt, even partially: creating or deleting pages or routes; layout, styling, or structural redesigns; new components or features; editing package.json, lockfiles, configs, CI workflows, or anything in .github/; installing dependencies; running commands.

Evaluate EACH request independently: apply the ones that are allowed, and reject only the ones that are out of scope — one rejected request must never block the others. If a request is out of scope, or you cannot find the content it refers to, make no edits for that request and reject it.

Many sites use a CMS contract: _site.json (site-wide data and SEO), _pages.json (per-page content addressed by dotted field paths like home.hero.headline), _collections/*.json (repeatable items). If the requested content lives in these files, edit the JSON value there (keep structure and keys intact) rather than hardcoding text in components. If the repo has a CLAUDE.md or AGENTS.md, follow its content-editing conventions where they do not conflict with these rules.

When you reject a request, the reason is shown directly to the website owner — a non-technical client. Write it warmly and politely, in second person, without technical jargon (no "structural change", "layout system", "repo"). Follow this shape: briefly acknowledge the request, explain in plain words that design changes like redesigns, new sections, or new pages are not something the automatic editor can do, and kindly point them to their developer/admin for it. Example tone: "Thanks for your request! Redesigning a page or adding new sections is something your developer handles personally to keep your site looking its best. Please reach out to them and they will be happy to help. I can still update text, images, and contact details for you anytime."

Your VERY LAST line of output must be exactly one JSON array with one entry per request id, nothing after it:
[{"id":<request id>,"status":"done","summary":"<one sentence describing the change>"},{"id":<request id>,"status":"rejected","reason":"<the polite client-facing message described above>"}]
Every request id must appear exactly once.`;

// Paths the AI must never change; any hit reverts the batch's edits.
const DENYLIST_PATTERNS: RegExp[] = [
  /^package\.json$/,
  /(^|\/)package\.json$/,
  /lock/i,
  /^\.github\//,
  /(^|\/)node_modules\//,
  /^astro\.config\./,
  /^next\.config\./,
  /^tsconfig/,
  /^Dockerfile/i,
  /^docker-compose/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)AGENTS\.md$/i,
  /^\.env/,
  /(^|\/)\.env/,
];

export const findForbiddenPaths = (paths: string[]) => {
  return paths.filter((path) =>
    DENYLIST_PATTERNS.some((pattern) => pattern.test(path))
  );
};

type Job = typeof job.$inferSelect;

export const buildBatchPrompt = (jobs: Job[]) => {
  const blocks = jobs.map((row, index) => {
    const lines = [`Request ${index + 1} (id ${row.id}): ${row.prompt}`];
    if (row.pageUrl) {
      lines.push(`  Page: ${row.pageUrl}`);
    }
    if (row.fieldPath) {
      lines.push(`  CMS field path: ${row.fieldPath}`);
    }
    if (row.elementSelector) {
      lines.push(`  Element selector on that page: ${row.elementSelector}`);
    }
    return lines.join('\n');
  });
  return `Client edit request(s):\n\n${blocks.join('\n\n')}`;
};

export type Verdict =
  | { id: number; status: 'done'; summary: string }
  | { id: number; status: 'rejected'; reason: string };

/**
 * The verdicts are the last JSON array line of Claude's result text — one
 * entry per request id. Returns null unless every expected id has a valid
 * verdict.
 */
export const parseVerdicts = (
  resultText: string,
  expectedIds: number[]
): Verdict[] | null => {
  const lines = resultText.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('[')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    const verdicts: Verdict[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry.id === 'number' &&
        entry.status === 'done' &&
        typeof entry.summary === 'string'
      ) {
        verdicts.push({ id: entry.id, status: 'done', summary: entry.summary });
      } else if (
        entry &&
        typeof entry.id === 'number' &&
        entry.status === 'rejected' &&
        typeof entry.reason === 'string'
      ) {
        verdicts.push({ id: entry.id, status: 'rejected', reason: entry.reason });
      }
    }
    const ids = new Set(verdicts.map((verdict) => verdict.id));
    if (
      verdicts.length === expectedIds.length &&
      expectedIds.every((id) => ids.has(id))
    ) {
      return verdicts;
    }
  }
  return null;
};
