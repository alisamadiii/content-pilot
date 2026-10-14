/**
 * Build-time .astro source annotator — stamps `data-cms-src="<project?>:<file>:<line>"`
 * onto every plain HTML element so the preview overlay (and the AI) can map a
 * clicked element back to its exact source file and line.
 *
 * Ported from @alisamadiillc/cms-bridge (core/annotate.ts + astro.ts) into
 * dependency-free ESM so it can be copied into any client clone and run with
 * zero install. The Astro parser is resolved from the client's own node_modules.
 *
 * Two parsers exist in the wild and the client's astro version decides which:
 *  - Astro <= 7.2: `@astrojs/compiler` (Go/WASM). Async `parse(src, {position})`,
 *    AST of `{type:'element', name, position:{start:{offset,line}}, children}`
 *    with BYTE offsets.
 *  - Astro >= 7.3: `@astrojs/compiler-rs` (Rust). Sync `parse(src)`, ESTree/JSX
 *    AST (`JSXElement` → `openingElement` → `name`), UTF-16 CHAR offsets, no
 *    line numbers. Older clones may still carry the legacy package through
 *    `@astrojs/check` devDeps, but a lean Astro 7.3 clone has only compiler-rs —
 *    which is exactly the case that used to fail (and, being fail-open, shipped
 *    every page untagged so the overlay had nothing to select).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// npm may nest the compiler under astro rather than hoist it to the clone's
// top-level node_modules — in which case a bare import from THIS copied file
// fails to resolve (walks ai-analyzer/ -> clone/node_modules, not astro's nested
// tree). That is exactly what breaks in the container. Resolve the way astro
// itself does (from astro's own location), falling back to the clone root.
function resolveFromAstro(spec) {
  const cloneRequire = createRequire(join(process.cwd(), "package.json"));
  try {
    const astroRequire = createRequire(cloneRequire.resolve("astro/package.json"));
    return astroRequire.resolve(spec);
  } catch {
    return cloneRequire.resolve(spec);
  }
}

// Lazy, so merely loading this module (e.g. during Vite config load) never needs
// the compiler — only the actual .astro transform does. Resolves to
// `{ kind: 'rs' | 'legacy', parse }`.
let parserPromise;
function loadParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      const errors = [];
      try {
        const pkgJson = resolveFromAstro("@astrojs/compiler-rs/package.json");
        const entry = join(dirname(pkgJson), "dist/index.mjs");
        const mod = await import(pathToFileURL(entry).href);
        const parse = mod.parse ?? mod.default?.parse;
        if (typeof parse === "function") return { kind: "rs", parse };
        errors.push("@astrojs/compiler-rs: no parse export");
      } catch (e) {
        errors.push(`@astrojs/compiler-rs: ${e?.message ?? e}`);
      }
      try {
        const pkgJson = resolveFromAstro("@astrojs/compiler/package.json");
        const entry = join(dirname(pkgJson), "dist/node/index.js");
        const mod = await import(pathToFileURL(entry).href);
        const parse = mod.parse ?? mod.default?.parse;
        if (typeof parse === "function") return { kind: "legacy", parse };
        errors.push("@astrojs/compiler: no parse export");
      } catch (e) {
        errors.push(`@astrojs/compiler: ${e?.message ?? e}`);
      }
      throw new Error(
        `ai-analyzer: no Astro parser found in the client clone (tried ${errors.join("; ")})`
      );
    })();
  }
  return parserPromise;
}

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

/** Legacy @astrojs/compiler AST → annotated source (byte-offset splice). */
export function annotateWithLegacyAst(source, ast, opts) {
  const buf = Buffer.from(source);
  const inserts = [];
  collectInserts(ast, buf, opts.project, opts.srcPath, inserts);
  return spliceInserts(buf, inserts);
}

// ---------------------------------------------------------------------------
// @astrojs/compiler-rs path. Offsets are UTF-16 string indices, so everything
// here works on the string, never the Buffer.

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
 * Char offset where ` data-cms-src="…"` goes for an opening tag that spans
 * [start, end): before the terminating `>`, or before the `/` of `/>`. The
 * parser already bounds the tag, so no quote/brace scanning is needed.
 */
function rsInsertOffset(source, start, end) {
  let i = end - 1;
  if (source[i] !== ">") return -1;
  let j = i - 1;
  while (j > start && isSpace(source[j])) j--;
  if (source[j] === "/") {
    while (j > start && isSpace(source[j - 1])) j--;
    return j;
  }
  return i;
}

/**
 * Plain HTML element, not a component/fragment/custom tag we must leave alone.
 * Components are capitalised (`<Header/>`) or member expressions (`<Foo.Bar/>`);
 * the parser types both as JSXElement, so the name decides.
 */
function rsIsPlainElement(opening) {
  const name = opening?.name;
  if (!name || name.type !== "JSXIdentifier" || typeof name.name !== "string")
    return false;
  const tag = name.name;
  if (!tag) return false;
  const c = tag.charCodeAt(0);
  if (c < 0x61 || c > 0x7a) return false; // not a-z → component / Fragment
  return !SKIP_TAGS.has(tag);
}

function rsCollect(node, source, starts, project, srcPath, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) rsCollect(n, source, starts, project, srcPath, out);
    return;
  }
  if (node.type === "JSXElement" && node.openingElement) {
    const o = node.openingElement;
    if (
      rsIsPlainElement(o) &&
      Number.isInteger(o.start) &&
      Number.isInteger(o.end)
    ) {
      const offset = rsInsertOffset(source, o.start, o.end);
      if (offset !== -1) {
        out.push({
          offset,
          text: ` ${SRC_ATTR}="${formatSrc(project, srcPath, lineAt(starts, o.start))}"`,
        });
      }
    }
  }
  // Generic walk: elements also live inside `{list.map(() => <li/>)}` expression
  // bodies, fragments, conditionals… Only `frontmatter` (the TS program) is
  // skipped — no markup there, and it's the bulk of the tree.
  for (const key of Object.keys(node)) {
    if (key === "frontmatter" || key === "openingElement" || key === "closingElement")
      continue;
    const v = node[key];
    if (v && typeof v === "object")
      rsCollect(v, source, starts, project, srcPath, out);
  }
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

/** @astrojs/compiler-rs AST → annotated source (char-offset splice). */
export function annotateWithRsAst(source, ast, opts) {
  const inserts = [];
  rsCollect(ast, source, lineStarts(source), opts.project, opts.srcPath, inserts);
  return spliceString(source, inserts);
}

/**
 * Annotate one .astro source string. Returns new source, or null if nothing to
 * do. `parser` is injectable for tests; production resolves it from the clone.
 */
export async function annotateAstroSource(source, opts, parser) {
  const { kind, parse } = parser ?? (await loadParser());
  // `await` is harmless on the sync compiler-rs parse.
  const { ast } = await parse(source, { position: true });
  return kind === "rs"
    ? annotateWithRsAst(source, ast, opts)
    : annotateWithLegacyAst(source, ast, opts);
}
