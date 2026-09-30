/**
 * AI-analyzer Astro integration — the preview-only replacement for cms-bridge.
 *
 * Injected into a client clone ONLY during a live preview session (never
 * committed, never shipped). It stamps `data-cms-src="<project?>:<file>:<line>"`
 * on every DOM element via the shared `enforce:'pre'` Vite plugin (same plugin
 * the non-Astro Vite frameworks use), so the overlay can map a clicked element
 * to its source.
 *
 * The overlay client script itself is no longer injected here — it now ships
 * framework-agnostically from the preview proxy (see src/preview/proxy.ts), so
 * every framework gets it the same way and there's no double injection.
 */

import { annotateAstroSource } from "./annotate.mjs";
import { aiAnalyzerVite } from "./vite-plugin.mjs";

export default function aiAnalyzer({ project, pathPrefix = "" } = {}) {
  return {
    name: "ai-analyzer",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              // @astrojs/compiler is guaranteed here (Astro clone). Passing the
              // annotator in keeps vite-plugin.mjs free of that import so
              // non-Astro configs never try to resolve it.
              aiAnalyzerVite({
                project,
                pathPrefix,
                astroAnnotator: annotateAstroSource,
              }),
            ],
          },
        });
      },
    },
  };
}
