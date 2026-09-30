/**
 * Build-time JSX/TSX source annotator — the React/Vite twin of annotate.mjs.
 * Stamps `data-cms-src="<project?>:<file>:<line>"` onto every intrinsic DOM
 * element (lowercase JSX tag) so the preview overlay (and the AI) can map a
 * clicked element back to its exact source file and line, identical to what the
 * Astro compiler transform produces for `.astro` files.
 *
 * Same string-splice technique as annotate.mjs: parse, collect offsets, splice
 * descending. We insert right after the tag name using Babel's char offsets, so
 * every other offset — and therefore `loc.start.line` — stays truthful. That
 * line is what buildPinnedFile reports to the AI, so it must never drift, which
 * is why we splice instead of regenerating with @babel/generator.
 *
 * @babel/parser is bundled into ./vendor/jsx-deps.mjs so this runs in any client
 * clone with zero install (React/Vite clones don't reliably ship Babel).
 */

import { parse } from "./vendor/jsx-deps.mjs";

export const SRC_ATTR = "data-cms-src";

// Lowercase tags that render to the DOM but should never carry the attribute
// (either invisible or their attributes get stripped by the framework).
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
]);

function formatSrc(project, relPath, line) {
  return `${project ? project + ":" : ""}${relPath}:${line}`;
}

// Intrinsic elements are lowercase JSXIdentifiers (div, h1, a). Capitalized
// (<Button/>) are components — React drops unknown props unless the component
// forwards them, so the attribute wouldn't reach the DOM. Member (<motion.div/>)
// and namespaced (<svg:path/>) elements are skipped for the same reason.
function intrinsicName(nameNode) {
  if (!nameNode || nameNode.type !== "JSXIdentifier") return null;
  const name = nameNode.name;
  return /^[a-z]/.test(name) ? name : null;
}

function alreadyTagged(openingEl) {
  return (openingEl.attributes ?? []).some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      attr.name?.type === "JSXIdentifier" &&
      attr.name.name === SRC_ATTR
  );
}

function collectInserts(node, project, srcPath, out, seen) {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);

  if (node.type === "JSXOpeningElement") {
    const name = intrinsicName(node.name);
    if (name && !SKIP_TAGS.has(name) && !alreadyTagged(node)) {
      // Insert right after the tag name: `<div` -> `<div data-cms-src="…"`.
      const offset = node.name.end;
      const line = node.loc?.start?.line ?? 1;
      if (typeof offset === "number") {
        out.push({
          offset,
          text: ` ${SRC_ATTR}="${formatSrc(project, srcPath, line)}"`,
        });
      }
    }
  }

  for (const key in node) {
    if (key === "loc" || key === "start" || key === "end" || key === "range")
      continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) collectInserts(item, project, srcPath, out, seen);
    } else if (child && typeof child.type === "string") {
      collectInserts(child, project, srcPath, out, seen);
    }
  }
}

function spliceInserts(source, inserts) {
  if (!inserts.length) return null;
  inserts.sort((a, b) => b.offset - a.offset);
  let out = source;
  for (const ins of inserts) {
    out = out.slice(0, ins.offset) + ins.text + out.slice(ins.offset);
  }
  return out;
}

/** Annotate one .jsx/.tsx source string. Returns new source, or null if nothing to do. */
export function annotateJsxSource(source, opts) {
  try {
    const ast = parse(source, {
      sourceType: "module",
      errorRecovery: true,
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });
    const inserts = [];
    collectInserts(ast.program, opts.project, opts.srcPath, inserts, new Set());
    return spliceInserts(source, inserts);
  } catch {
    // Fail-open — a source we can't parse must never break the preview build.
    return null;
  }
}
