/**
 * Bundles the JSX-tagger's only third-party dep (@babel/parser) into a single
 * self-contained ESM file at ai-analyzer/vendor/jsx-deps.mjs, so the analyzer
 * folder copied into a client clone runs with zero install — React/Vite clones
 * don't reliably ship Babel. The output is committed; runtime never installs it.
 *
 * Run: node scripts/build-analyzer.mjs  (wired into `prepare` + `build`).
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  stdin: {
    contents: `export { parse } from "@babel/parser";`,
    resolveDir: root,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  minify: true,
  legalComments: "none",
  outfile: join(root, "ai-analyzer", "vendor", "jsx-deps.mjs"),
});

console.log("built ai-analyzer/vendor/jsx-deps.mjs");
