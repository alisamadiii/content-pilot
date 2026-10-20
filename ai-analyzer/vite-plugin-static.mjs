/**
 * Vite plugin for PLAIN STATIC repos (no package.json): stamps `data-cms-src`
 * on every served .html page and force-reloads the preview after AI edits.
 * Kept separate from vite-plugin.mjs so the static wrapper config never
 * references annotate-jsx.mjs or any framework package the clone lacks.
 *
 * transformIndexHtml with order:'pre' is load-bearing: the handler sees the RAW
 * on-disk HTML (before Vite injects /@vite/client), so the stamped line numbers
 * match the source file the AI edits.
 */

import { annotateHtmlSource } from "./annotate-html.mjs";

const toRel = (root, id) => {
  let rel = id;
  if (root && id.startsWith(root)) rel = id.slice(root.length);
  return rel.replace(/^\/+/, "").split("\\").join("/");
};

export function aiAnalyzerStatic({ project = "" } = {}) {
  let root = process.cwd();
  let warned = false;
  return {
    name: "ai-analyzer-static",
    configResolved(config) {
      if (config?.root) root = config.root;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const srcPath = toRel(root, ctx.filename ?? ctx.path ?? "");
        if (!srcPath || srcPath.startsWith("ai-analyzer/")) return html;
        try {
          return annotateHtmlSource(html, { project, srcPath }) ?? html;
        } catch (err) {
          // Fail-open — annotation must never break the preview. But say so
          // once: a silent catch hides "overlay selects nothing" causes.
          if (!warned) {
            warned = true;
            console.warn(
              `[ai-analyzer] html annotation failed for ${srcPath}; page ships untagged: ${
                err?.message ?? err
              }`
            );
          }
          return html;
        }
      },
    },
    // Plain css/js referenced from <link>/<script src> is not in Vite's module
    // graph (no importer), so edits to it would never HMR. Force a full reload
    // for every site-file change — static pages reload in milliseconds.
    handleHotUpdate({ file, server }) {
      if (/\.(html|css|m?js)$/i.test(file) && !file.includes("ai-analyzer")) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
  };
}
