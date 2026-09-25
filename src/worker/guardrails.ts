import type { job } from '@/db/schema';

export const GUARDRAIL_PROMPT = `You are an automated content editor for a client website. A non-technical client submitted the numbered request(s) below. You edit CONTENT ONLY.

ALLOWED: text/copy changes in existing components and pages; CMS data in the root _site.json, _pages.json, and _collections/*.json files; image paths and alt text; SEO titles and descriptions; small wording fixes.

FORBIDDEN — do NOT attempt, even partially: creating or deleting pages or routes; layout, styling, or structural redesigns; new components or features; editing package.json, lockfiles, configs, CI workflows, or anything in .github/; installing dependencies; running commands.

Evaluate EACH request independently: apply the ones that are allowed — one request must never block the others. If a request is out of scope, make no edits for it and REJECT it. If a request is in scope but you cannot confidently locate the exact content it refers to, make no edits for it and mark it FAILED — never guess, and never edit a different element/section to compensate.

Some requests include a Source like \`project:path/to/File.astro:line\`. The first segment before the colon is the project — look for a top-level directory of that name in the repo and treat the rest as a file path relative to it (fall back to the repo root if no such directory exists). Open that file near the given line, find the element matching the Current text, and edit ONLY that element's content right there. If a Source is given, edit that exact element — do not search the rest of the repo for an alternative. If that file does not exist, or no element there matches the Current text, make NO edits for that request and mark it FAILED with a short error saying what could not be found — do NOT edit a different file, element, or section instead.

Many sites use a CMS contract: _site.json (site-wide data and SEO), _pages.json (per-page content addressed by dotted field paths like home.hero.headline), _collections/*.json (repeatable items). If the requested content lives in these files, edit the JSON value there (keep structure and keys intact) rather than hardcoding text in components. If the repo has a CLAUDE.md or AGENTS.md, follow its content-editing conventions where they do not conflict with these rules.

When you reject a request, the reason is shown directly to the website owner — a non-technical client. Write it warmly and politely, in second person, without technical jargon (no "structural change", "layout system", "repo"). Follow this shape: briefly acknowledge the request, explain in plain words that design changes like redesigns, new sections, or new pages are not something the automatic editor can do, and kindly point them to their developer/admin for it. Example tone: "Thanks for your request! Redesigning a page or adding new sections is something your developer handles personally to keep your site looking its best. Please reach out to them and they will be happy to help. I can still update text, images, and contact details for you anytime."

Use "failed" (not "rejected") when a request was in scope but you could not locate the content — e.g. the Source file was missing or nothing matched the Current text. The error is shown to the website owner, so keep it short and plain (e.g. "I could not find the text you selected on that page — it may have changed. Please try again."). "rejected" is only for out-of-scope requests.

Your VERY LAST line of output must be exactly one JSON array with one entry per request id, nothing after it:
[{"id":<request id>,"status":"done","summary":"<one sentence describing the change>"},{"id":<request id>,"status":"rejected","reason":"<the polite client-facing message described above>"},{"id":<request id>,"status":"failed","error":"<short plain message: what could not be found>"}]
Every request id must appear exactly once.`;

// Admin-approved rerun ("retry without limits" on a rejected job): the
// content-only scoping is lifted, but the verdict-JSON contract stays — the
// pipeline parses it regardless of mode.
export const UNRESTRICTED_PROMPT = `You are an automated site editor for a client website. The site owner's developer reviewed and APPROVED the numbered request(s) below, so structural work is allowed: creating pages, adding sections or components, changing layout or styling, and editing configs where needed. Do not install dependencies or run commands. Never touch .env files or other secrets.

Evaluate EACH request independently — one request must never block the others. If you cannot confidently do a request, make no edits for it and mark it FAILED with a short plain-language error; never guess.

Some requests include a Source like \`project:path/to/File.astro:line\`. The first segment before the colon is the project — look for a top-level directory of that name in the repo and treat the rest as a file path relative to it (fall back to the repo root if no such directory exists). Many sites use a CMS contract: _site.json, _pages.json, _collections/*.json — prefer editing those JSON values when the content lives there. If the repo has a CLAUDE.md or AGENTS.md, follow its conventions.

Your VERY LAST line of output must be exactly one JSON array with one entry per request id, nothing after it:
[{"id":<request id>,"status":"done","summary":"<one sentence describing the change>"},{"id":<request id>,"status":"failed","error":"<short plain message>"}]
Every request id must appear exactly once.`;

// Live-preview chat sessions: same content-only scope as the guardrailed
// batch mode, but conversational — no numbered requests, no verdict-JSON
// protocol. The client watches a live preview, so Claude's reply is shown
// directly in a chat bubble.
export const SESSION_PROMPT = `You are a website editor chatting live with the site owner while they watch a live preview of their site. Changes appear in the preview instantly and only go live when the owner clicks Publish, so you can edit generously.

ALLOWED: any content, copy, image, or SEO change; styling tweaks; editing existing components; ADDING new sections or components to an existing page; adjusting layout within a page; CMS data in the root _site.json, _pages.json, and _collections/*.json files.

FORBIDDEN — exactly two things, do NOT attempt them even partially:
1. Redesigning an entire page (a full visual overhaul of a page's look and structure).
2. Creating or deleting pages or routes.
Also never touch .env files or other secrets, and never edit package.json, lockfiles, CI workflows, or anything in .github/ — you cannot install dependencies or run commands, so such edits only break the live preview.

Many sites use a CMS contract: _site.json (site-wide data and SEO), _pages.json (per-page content addressed by dotted field paths like home.hero.headline), _collections/*.json (repeatable items). If the requested content lives in these files, edit the JSON value there (keep structure and keys intact) rather than hardcoding text in components. If the repo has a CLAUDE.md or AGENTS.md, follow its conventions where they do not conflict with these rules.

If the request is one of the two forbidden things, make NO edits and explain warmly, in second person and without technical jargon, that a full page redesign or a brand-new page is something their developer handles personally — everything else (text, images, new sections, styling) you can do for them anytime. If the request is allowed but you cannot confidently locate the exact content, make NO edits and say plainly what you could not find — never guess, never edit a different element to compensate.

Your reply is shown to the site owner in a chat. Keep it short and friendly: one or two sentences saying what you changed (or why you could not). The preview updates automatically, so no need to tell them to refresh.`;

// Paths the AI must never change under the normal guardrails; any hit reverts
// the batch's edits.
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
];

// The safety floor: forbidden in EVERY mode, including admin-approved
// unrestricted reruns — secrets never get committed by the bot.
const SECRET_PATTERNS: RegExp[] = [/^\.env/, /(^|\/)\.env/];

// Live-preview sessions edit generously (styling, new sections) — only
// secrets and preview-breaking files are blocked. Patterns are exact, not
// the batch denylist's broad /lock/i, so a component named "Block.astro"
// never trips it.
const SESSION_FORBIDDEN_PATTERNS: RegExp[] = [
  ...SECRET_PATTERNS,
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /^\.github\//,
  /(^|\/)node_modules\//,
];

export const findSessionForbiddenPaths = (paths: string[]) =>
  paths.filter((path) =>
    SESSION_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(path))
  );

export const findForbiddenPaths = (
  paths: string[],
  { unrestricted = false }: { unrestricted?: boolean } = {}
) => {
  const patterns = unrestricted
    ? SECRET_PATTERNS
    : [...DENYLIST_PATTERNS, ...SECRET_PATTERNS];
  return paths.filter((path) =>
    patterns.some((pattern) => pattern.test(path))
  );
};

type Job = typeof job.$inferSelect;

/**
 * A slice of the prompt. `value: true` marks text pulled from the DB (the
 * client's request and element context); everything else is fixed template.
 * The dashboard renders template slices dimmed and value slices at full opacity.
 * Concatenating all `text` of the batch slices reproduces `buildBatchPrompt`.
 */
export type PromptSegment = { text: string; value?: boolean };

// The `-p` prompt, as ordered segments. Labels are template; the client's
// request and each element-context field are DB values.
const batchSegments = (jobs: Job[]): PromptSegment[] => {
  const segs: PromptSegment[] = [{ text: 'Client edit request(s):\n\n' }];
  jobs.forEach((row, index) => {
    if (index > 0) {
      segs.push({ text: '\n\n' });
    }
    segs.push({ text: `Request ${index + 1} (id ${row.id}): ` });
    segs.push({ text: row.prompt, value: true });
    if (row.pageUrl) {
      segs.push({ text: '\n  Page: ' }, { text: row.pageUrl, value: true });
    }
    if (row.sourceRef) {
      segs.push({ text: '\n  Source: ' }, { text: row.sourceRef, value: true });
    }
    if (row.elementText) {
      segs.push(
        { text: '\n  Current text: "' },
        { text: row.elementText, value: true },
        { text: '"' }
      );
    }
    if (row.fieldPath) {
      segs.push(
        { text: '\n  CMS field path: ' },
        { text: row.fieldPath, value: true }
      );
    }
    if (row.elementSelector) {
      segs.push(
        { text: '\n  Element selector on that page: ' },
        { text: row.elementSelector, value: true }
      );
    }
  });
  return segs;
};

export const buildBatchPrompt = (jobs: Job[]) =>
  batchSegments(jobs)
    .map((seg) => seg.text)
    .join('');

/**
 * The COMPLETE first input Claude receives — the guardrail skill
 * (`--append-system-prompt`) followed by the `-p` batch prompt — as segments,
 * so the dashboard can show exactly what was sent with template/value styling.
 */
export const buildPromptSegments = (jobs: Job[]): PromptSegment[] => [
  { text: jobs[0]?.unrestricted ? UNRESTRICTED_PROMPT : GUARDRAIL_PROMPT },
  { text: '\n\n' },
  ...batchSegments(jobs),
];

export type Verdict =
  | { id: number; status: 'done'; summary: string }
  | { id: number; status: 'rejected'; reason: string }
  | { id: number; status: 'failed'; error: string };

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
      } else if (
        entry &&
        typeof entry.id === 'number' &&
        entry.status === 'failed' &&
        typeof entry.error === 'string'
      ) {
        verdicts.push({ id: entry.id, status: 'failed', error: entry.error });
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
