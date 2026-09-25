/**
 * AI-analyzer Astro integration — the preview-only replacement for cms-bridge.
 *
 * Injected into a client clone ONLY during a live preview session (never
 * committed, never shipped). It:
 *   - stamps `data-cms-src="<project?>:<file>:<line>"` on every HTML element via
 *     an `order:"pre"` Vite transform (same annotate core as cms-bridge), so the
 *     overlay can map a clicked element to its source, and
 *   - injects the overlay script that posts the picked element up to the hub.
 *
 * The preview wrapper config strips the client's committed cms-bridge and adds
 * this instead, so exactly one integration annotates — no double build.
 */

import { readFileSync } from "node:fs";
import { annotateAstroSource } from "./annotate.mjs";

export default function aiAnalyzer({ project, pathPrefix = "" } = {}) {
  return {
    name: "ai-analyzer",
    hooks: {
      "astro:config:setup": ({ config, injectScript, updateConfig, logger }) => {
        const rootDir = config.root;

        updateConfig({
          vite: {
            plugins: [
              {
                name: "ai-analyzer-src",
                transform: {
                  order: "pre",
                  async handler(source, id) {
                    if (!id.endsWith(".astro") || id.includes("node_modules"))
                      return null;
                    if (source.includes("astro/compiler-runtime")) return null;
                    try {
                      const srcPath =
                        pathPrefix +
                        id
                          .slice(rootDir.pathname.length)
                          .replace(/^\/+/, "")
                          .split("\\")
                          .join("/");
                      const code = await annotateAstroSource(source, {
                        project,
                        srcPath,
                      });
                      if (code == null) return null;
                      return { code, map: null };
                    } catch (err) {
                      // Fail-open — annotation must never break the preview build.
                      logger.warn(
                        `ai-analyzer skipped ${id}: ${err instanceof Error ? err.message : err}`
                      );
                      return null;
                    }
                  },
                },
              },
            ],
          },
        });

        // Framed flag only — no secret, no repo identity needed (the overlay
        // just posts to the hub parent window).
        injectScript("page", "window.__AI_ANALYZER__=1;");
        injectScript(
          "page",
          readFileSync(new URL("./overlay.js", import.meta.url), "utf-8")
        );
      },
    },
  };
}
