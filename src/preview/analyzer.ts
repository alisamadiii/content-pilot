import { cpSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureGitExclude } from '../worker/git';
import {
  type BootPlan,
  detectFramework,
  findAstroConfig,
  findViteConfig,
} from './framework';

// The maintained source-of-truth folder, copied into each client clone. The
// supervisor runs from the content-pilot repo root (tsx src/preview/index.ts),
// so cwd is the repo root in both local dev and the container (WORKDIR /app).
const ANALYZER_SRC = join(process.cwd(), 'ai-analyzer');

// The HMR block is load-bearing on both Vite paths: Vite's client defaults its
// websocket to the dev server's OWN port (e.g. wss://<id>.<domain>:4100), which
// is unreachable through the preview proxy/Cloudflare — live updates silently
// die and the client must hard-reload. Pointing the client at the PUBLIC
// scheme/port (env from spawnDevServer) routes HMR through the proxy.
const HMR_SNIPPET = `const hmr = {
  protocol: process.env.PREVIEW_PUBLIC_PROTOCOL === 'https' ? 'wss' : 'ws',
  clientPort: Number(process.env.PREVIEW_PUBLIC_PORT) || 443,
};`;

// Wrapper config for Astro: extend the client's real config, drop its committed
// cms-bridge integration, add the analyzer. Exactly one integration then
// annotates — no double build.
const astroWrapper = (configName: string | null) => `${
  configName
    ? `import base from ${JSON.stringify(`../${configName}`)};`
    : 'const base = {};'
}
import aiAnalyzer from './integration.mjs';

const list = (base.integrations ?? []).filter((i) => i?.name !== 'cms-bridge');

${HMR_SNIPPET}

// Adapters are for builds; in dev the cloudflare adapter's platformProxy
// spawns the glibc-only workerd binary, which cannot exec in the alpine
// container. astro dev serves every route (incl. prerender=false endpoints)
// in plain node without an adapter, so previews simply drop it.
const { adapter: _adapter, ...rest } = base;

export default {
  ...rest,
  // PREVIEW ONLY: allow any https remote image so client-pasted CDN URLs
  // (Unsplash etc.) render instead of 500ing the page.
  image: {
    ...(rest.image ?? {}),
    remotePatterns: [...(rest.image?.remotePatterns ?? []), { protocol: 'https' }],
  },
  vite: {
    ...(base.vite ?? {}),
    server: { ...(base.vite?.server ?? {}), hmr },
  },
  integrations: [...list, aiAnalyzer({})],
};
`;

// Wrapper config for the generic Vite frameworks (TanStack Start, Vite + React).
// Imports the client's real vite config (object | function | promise), strips
// the cloudflare plugin (workerd is glibc-only and can't exec in the container,
// same reason astro drops the cloudflare adapter), and appends the shared
// analyzer tagger. mergeConfig concatenates plugins, so the tagger runs
// alongside the client's own.
const viteWrapper = (configName: string | null) => `import { mergeConfig } from 'vite';
import { aiAnalyzerVite } from './vite-plugin.mjs';
${configName ? `import baseExport from ${JSON.stringify(`../${configName}`)};` : 'const baseExport = {};'}

const maybe = typeof baseExport === 'function'
  ? await baseExport({ command: 'serve', mode: 'development' })
  : baseExport;
const base = maybe && maybe.default ? maybe.default : maybe;

const plugins = (base.plugins ?? [])
  .flat(Infinity)
  .filter((p) => p && !/cloudflare/i.test(p.name ?? ''));

${HMR_SNIPPET}

// Our tagger MUST run before the framework's own JSX transform (tanstackStart /
// plugin-react), or it sees already-compiled source with collapsed line numbers.
// enforce:'pre' + being FIRST in the array guarantees that ordering, so the
// aiAnalyzer config goes first and the client's plugins follow.
export default mergeConfig(
  { plugins: [aiAnalyzerVite({})] },
  {
    ...base,
    plugins,
    server: { ...(base.server ?? {}), hmr, allowedHosts: true },
  }
);
`;

// Wrapper config for plain static repos, served by the PILOT's own Vite (see
// pilotViteBin in session-boot). Import-free apart from the sibling plugin: a
// bare `import ... from 'vite'` could never resolve from a clone outside the
// pilot install, and there is no client config to merge anyway.
const staticWrapper = () => `import { aiAnalyzerStatic } from './vite-plugin-static.mjs';

${HMR_SNIPPET}

export default {
  // MPA: /about and /about/ serve about.html / about/index.html as real pages;
  // no SPA fallback swallowing unknown paths into index.html.
  appType: 'mpa',
  // Vite's default cacheDir is node_modules/.vite in the CLONE — static repos
  // often have no .gitignore, so publish's \`git add -A\` would stage it.
  // ai-analyzer/ is already git-excluded.
  cacheDir: 'ai-analyzer/.vite',
  plugins: [aiAnalyzerStatic({})],
  server: { hmr, allowedHosts: true },
};
`;

/**
 * Inject the AI analyzer into a client clone for the PREVIEW ONLY. Returns a
 * BootPlan describing how to spawn the tagged dev server, or null when the
 * project is unsupported (startSession refuses those before getting here).
 *
 * Nothing here is committable:
 *  - the analyzer folder is copied under `<dir>/ai-analyzer/` and the repo's
 *    `.git/info/exclude` is extended so git never sees it (belt-and-braces
 *    beyond the client's own .gitignore), and
 *  - the real config is never modified — Astro/Vite import it via the dev
 *    server's `--config` wrapper — so `discardChanges` (git reset --hard) has
 *    nothing to revert and `git add -A` has nothing to stage.
 */
export const injectAnalyzer = (dir: string): BootPlan | null => {
  if (!existsSync(ANALYZER_SRC)) return null;
  const framework = detectFramework(dir);
  if (!framework) return null;

  const destDir = join(dir, 'ai-analyzer');
  cpSync(ANALYZER_SRC, destDir, { recursive: true });
  ensureGitExclude(dir, 'ai-analyzer/');

  if (framework === 'static') {
    writeFileSync(
      join(destDir, 'preview.static.config.mjs'),
      staticWrapper()
    );
    return {
      framework: 'static',
      configPath: 'ai-analyzer/preview.static.config.mjs',
    };
  }

  if (framework === 'astro') {
    // `astro` dep but no config file still gets the wrapper (empty base).
    writeFileSync(
      join(destDir, 'preview.config.mjs'),
      astroWrapper(findAstroConfig(dir))
    );
    return { framework: 'astro', configPath: 'ai-analyzer/preview.config.mjs' };
  }

  if (framework === 'vite') {
    writeFileSync(
      join(destDir, 'preview.vite.config.mjs'),
      viteWrapper(findViteConfig(dir))
    );
    return {
      framework: 'vite',
      configPath: 'ai-analyzer/preview.vite.config.mjs',
    };
  }

  return null;
};
