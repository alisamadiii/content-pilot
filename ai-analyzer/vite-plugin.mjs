/**
 * Shared Vite plugin that stamps `data-cms-src` on `.jsx`/`.tsx` sources, so one
 * injected plugin serves every Vite-based framework (Astro islands, TanStack
 * Start, Vite + React). `.astro` support is opt-in via the `astroAnnotator`
 * argument: integration.mjs passes it (Astro clones have @astrojs/compiler),
 * while non-Astro configs pass nothing — so their Vite config bundle never
 * references @astrojs/compiler, a package they don't have installed.
 *
 * `enforce: 'pre'` is load-bearing: we must see the original source (and its
 * real line numbers) before plugin-react / tanstackStart / the Astro compiler
 * rewrite it.
 */

import { annotateJsxSource } from "./annotate-jsx.mjs";

const toRel = (root, id) => {
  let rel = id;
  if (root && id.startsWith(root)) rel = id.slice(root.length);
  return rel.replace(/^\/+/, "").split("\\").join("/");
};

export function aiAnalyzerVite({
  project = "",
  pathPrefix = "",
  astroAnnotator = null,
} = {}) {
  let root = process.cwd();
  return {
    name: "ai-analyzer-src",
    enforce: "pre",
    configResolved(config) {
      if (config?.root) root = config.root;
    },
    // Object-hook form with order:'pre' is load-bearing for Astro: it forces the
    // handler to run BEFORE Astro compiles the .astro source to JS. Plugin-level
    // enforce:'pre' alone isn't enough — the handler would see compiled output
    // (which trips the compiler-runtime guard) and never annotate.
    transform: {
      order: "pre",
      async handler(source, id) {
        if (id.includes("node_modules")) return null;
        // Match the RAW id (no query-strip). Astro extracts <script>/<style>
        // blocks as virtual sub-modules with a query
        // (Hero.astro?astro&type=script&lang.ts); a query'd id never ends in
        // .astro/.tsx, so those are skipped. Annotating them would splice the
        // attribute into raw TS/CSS (e.g. inside `ReturnType<typeof setInterval>`)
        // and break the build. Only the primary bare-path module is annotated.
        const isAstro = id.endsWith(".astro");
        const isJsx = /\.(jsx|tsx)$/.test(id);
        if ((isAstro && !astroAnnotator) || (!isAstro && !isJsx)) return null;
        // Skip Astro's already-compiled runtime output.
        if (isAstro && source.includes("astro/compiler-runtime")) return null;

        const srcPath = pathPrefix + toRel(root, id);
        try {
          const code = isAstro
            ? await astroAnnotator(source, { project, srcPath })
            : annotateJsxSource(source, { project, srcPath });
          if (code == null) return null;
          return { code, map: null };
        } catch {
          // Fail-open — annotation must never break the preview build.
          return null;
        }
      },
    },
  };
}
