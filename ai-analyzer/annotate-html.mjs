/**
 * Plain-HTML source annotator — stamps `data-cms-src="<project?>:<file>:<line>"`
 * onto every taggable element of a static site's .html files, so the preview
 * overlay (and the AI) can map a clicked element back to its exact source file
 * and line. The static-repo sibling of annotate.mjs (.astro) and
 * annotate-jsx.mjs (.jsx/.tsx), sharing their attribute and ref format.
 *
 * Dependency-free single-pass tokenizer, not a real HTML parser: it only needs
 * to find opening tags and their terminating `>`, skipping comments and
 * raw-text element bodies (a `<div>` inside a script string or a textarea is
 * text, not markup). Runs on the RAW on-disk source (the Vite plugin hooks
 * transformIndexHtml with order:'pre'), so the stamped line numbers match what
 * the AI reads with its file tools.
 */

export const SRC_ATTR = "data-cms-src";

const SKIP_TAGS = new Set([
  "html",
  "head",
  "body",
  "meta",
  "link",
  "title",
  "script",
  "style",
  "base",
  "noscript",
  "slot",
]);

// Elements whose BODY is raw/escapable-raw text in the HTML spec: anything
// tag-shaped inside them is content, never markup, so the scan jumps straight
// to their closing tag.
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

function formatSrc(project, relPath, line) {
  return `${project ? project + ":" : ""}${relPath}:${line}`;
}

/** Sorted array of offsets at which each line starts (line 1 → 0). */
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * Index of the `>` that terminates the tag opening at `start` (the `<`),
 * ignoring `>` inside quoted attribute values. -1 when the tag never closes.
 */
function tagEnd(source, start) {
  let quote = "";
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") return i;
  }
  return -1;
}

/**
 * Char offset where ` data-cms-src="…"` goes for an opening tag spanning
 * [start, end] (end = the `>`): before the `>`, or before the `/` of `/>`.
 */
function insertOffset(source, start, end) {
  let j = end - 1;
  while (j > start && isSpace(source[j])) j--;
  if (source[j] === "/") {
    while (j > start && isSpace(source[j - 1])) j--;
    return j;
  }
  return end;
}

function spliceString(source, inserts) {
  if (!inserts.length) return null;
  inserts.sort((a, b) => b.offset - a.offset);
  let out = source;
  for (const ins of inserts) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  }
  return out;
}

/**
 * Annotate one .html source string. Returns new source, or null if nothing to
 * do. Idempotent: tags already carrying data-cms-src are left alone.
 */
export function annotateHtmlSource(source, opts) {
  const { project = "", srcPath } = opts;
  const starts = lineStarts(source);
  const lower = source.toLowerCase();
  const inserts = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    if (source.startsWith("<!--", lt)) {
      const close = source.indexOf("-->", lt + 4);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    // Not an opening tag: </div>, <!DOCTYPE, <?xml, a stray `<` in text.
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(
      source.slice(lt + 1, lt + 64)
    );
    if (!nameMatch) {
      i = lt + 1;
      continue;
    }
    const tag = nameMatch[0].toLowerCase();
    const end = tagEnd(source, lt);
    if (end === -1) break;
    const openTag = source.slice(lt, end + 1);
    if (!SKIP_TAGS.has(tag) && !openTag.includes(`${SRC_ATTR}=`)) {
      inserts.push({
        offset: insertOffset(source, lt, end),
        text: ` ${SRC_ATTR}="${formatSrc(project, srcPath, lineAt(starts, lt))}"`,
      });
    }
    i = end + 1;
    if (RAW_TEXT_TAGS.has(tag) && !/\/\s*>$/.test(openTag)) {
      const close = lower.indexOf(`</${tag}`, i);
      i = close === -1 ? source.length : close;
    }
  }
  return spliceString(source, inserts);
}
