/**
 * Webpack loader that stamps `data-cms-src` on `.jsx`/`.tsx` sources for the
 * Next.js preview path (Vite frameworks use vite-plugin.mjs instead). Registered
 * `enforce:'pre'` in preview-next-server.mjs so it sees the original source and
 * real line numbers before Next's SWC/webpack pipeline rewrites it.
 *
 * CJS because webpack loaders load via require(); it async-imports the ESM
 * annotator (same core the Vite plugin uses) and returns via the async callback.
 */

const { pathToFileURL } = require("node:url");
const { join } = require("node:path");

const annotatorUrl = pathToFileURL(join(__dirname, "annotate-jsx.mjs")).href;

module.exports = function aiAnalyzerLoader(source) {
  const callback = this.async();
  const resourcePath = this.resourcePath;
  const root = this.rootContext || "";

  let rel = resourcePath;
  if (root && rel.startsWith(root)) rel = rel.slice(root.length);
  rel = rel.replace(/^[\\/]+/, "").split("\\").join("/");

  import(annotatorUrl)
    .then(({ annotateJsxSource }) => {
      let out = source;
      try {
        out = annotateJsxSource(source, { srcPath: rel, project: "" }) ?? source;
      } catch {
        out = source; // fail-open — never break the client's build
      }
      callback(null, out);
    })
    .catch(() => callback(null, source));
};
