/**
 * Build-time .astro source annotator — stamps `data-cms-src="<project?>:<file>:<line>"`
 * onto every plain HTML element so the preview overlay (and the AI) can map a
 * clicked element back to its exact source file and line.
 *
 * Ported verbatim from @alisamadiillc/cms-bridge (core/annotate.ts + astro.ts)
 * into dependency-free ESM so it can be copied into any client clone and run
 * with zero install. `@astrojs/compiler` is resolved from the client's own
 * node_modules (always present — it's an Astro dependency).
 */

import { parse } from "@astrojs/compiler";

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

function formatSrc(project, relPath, line) {
  return `${project ? project + ":" : ""}${relPath}:${line}`;
}

/**
 * Byte offset where ` data-cms-src="…"` should be spliced into the opening tag
 * starting at `start`: before the terminating `>`, or before the `/` of a
 * self-closing tag. Scans outside quoted values and `{…}` expressions.
 */
function findInsertOffset(buf, start) {
  let quote = 0;
  let braces = 0;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (quote) {
      if (c === quote) quote = 0;
      continue;
    }
    if (c === 0x22 || c === 0x27 || c === 0x60) {
      quote = c;
      continue;
    }
    if (c === 0x7b) braces++;
    else if (c === 0x7d && braces > 0) braces--;
    else if (c === 0x3e && braces === 0) {
      let j = i - 1;
      while (
        j > start &&
        (buf[j] === 0x20 || buf[j] === 0x09 || buf[j] === 0x0a || buf[j] === 0x0d)
      )
        j--;
      if (buf[j] === 0x2f) {
        while (
          j > start &&
          (buf[j - 1] === 0x20 ||
            buf[j - 1] === 0x09 ||
            buf[j - 1] === 0x0a ||
            buf[j - 1] === 0x0d)
        )
          j--;
        return j;
      }
      return i;
    }
  }
  return -1;
}

function spliceInserts(buf, inserts) {
  if (!inserts.length) return null;
  inserts.sort((a, b) => b.offset - a.offset);
  const parts = [];
  let end = buf.length;
  for (const ins of inserts) {
    parts.unshift(Buffer.from(ins.text), buf.subarray(ins.offset, end));
    end = ins.offset;
  }
  parts.unshift(buf.subarray(0, end));
  return Buffer.concat(parts).toString();
}

function collectInserts(node, buf, project, srcPath, out) {
  if (node.type === "element" && !SKIP_TAGS.has(node.name) && node.position?.start) {
    const offset = findInsertOffset(buf, node.position.start.offset);
    if (offset !== -1) {
      out.push({
        offset,
        text: ` ${SRC_ATTR}="${formatSrc(project, srcPath, node.position.start.line)}"`,
      });
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children)
      collectInserts(child, buf, project, srcPath, out);
  }
}

/** Annotate one .astro source string. Returns new source, or null if nothing to do. */
export async function annotateAstroSource(source, opts) {
  const { ast } = await parse(source, { position: true });
  const buf = Buffer.from(source);
  const inserts = [];
  collectInserts(ast, buf, opts.project, opts.srcPath, inserts);
  return spliceInserts(buf, inserts);
}
