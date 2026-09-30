import { execFileSync } from 'child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { extname, join } from 'path';
import {
  type BootPlan,
  detectFramework,
  findAstroConfig,
  findNextConfig,
  findViteConfig,
} from './framework';

// The maintained source-of-truth folder, copied into each client clone. The
// supervisor runs from the content-pilot repo root (tsx src/preview/index.ts),
// so cwd is the repo root in both local dev and the container (WORKDIR /app).
const ANALYZER_SRC = join(process.cwd(), 'ai-analyzer');

const ensureGitExclude = (dir: string, pattern: string) => {
  const excludePath = join(dir, '.git', 'info', 'exclude');
  try {
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, 'utf8')
      : '';
    if (current.split('\n').some((line) => line.trim() === pattern)) return;
    const prefix = !current || current.endsWith('\n') ? '' : '\n';
    appendFileSync(excludePath, `${prefix}${pattern}\n`);
  } catch {
    // Best-effort — the client's committed .gitignore is the primary guard.
  }
};

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
const astroWrapper = (configName: string) => `import base from ${JSON.stringify(
  `../${configName}`
)};
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

// The webpack loader body shared by the ESM and CJS Next wrappers: prepend an
// enforce:'pre' rule that stamps data-cms-src on .jsx/.tsx before Next's SWC.
const NEXT_WEBPACK_BODY = `const loaderPath = join(process.cwd(), 'ai-analyzer', 'next-tagger-loader.cjs');
const addLoader = (c) => {
  if (!c.module) c.module = {};
  if (!c.module.rules) c.module.rules = [];
  c.module.rules.unshift({
    test: /\\.(jsx|tsx)$/,
    exclude: /node_modules/,
    enforce: 'pre',
    use: [{ loader: loaderPath }],
  });
  return c;
};
const withWebpack = (base) => ({
  ...base,
  webpack(config, options) {
    const out = typeof base.webpack === 'function' ? base.webpack(config, options) : config;
    return addLoader(out);
  },
});`;

// Wrapper that Next loads as the project's next.config (overwrites the original
// in place; the real config is backed up under ai-analyzer/ and imported here).
// Next has no --config flag and its dev compiler reloads config from disk in
// worker threads, so passing a webpack fn programmatically is silently ignored —
// on-disk is the only place a webpack loader takes effect.
const nextWrapper = (importSpec: string | null, cjs: boolean) => {
  if (cjs) {
    return `const { join } = require('node:path');
${importSpec ? `const _m = require('${importSpec}');\nconst orig = _m && _m.default ? _m.default : _m;` : 'const orig = {};'}
${NEXT_WEBPACK_BODY}
module.exports = typeof orig === 'function'
  ? (...args) => withWebpack(orig(...args))
  : withWebpack(orig || {});
`;
  }
  return `import { join } from 'node:path';
${importSpec ? `import * as _m from '${importSpec}';\nconst orig = _m.default ?? _m;` : 'const orig = {};'}
${NEXT_WEBPACK_BODY}
export default typeof orig === 'function'
  ? (...args) => withWebpack(orig(...args))
  : withWebpack(orig ?? {});
`;
};

// Make git ignore working-tree changes to a tracked file (our config overwrite),
// so it never appears in diffs, the changed-files floor, or a publish. Best-effort.
const gitSkipWorktree = (dir: string, relPath: string, skip: boolean) => {
  try {
    execFileSync(
      'git',
      ['update-index', skip ? '--skip-worktree' : '--no-skip-worktree', relPath],
      { cwd: dir, stdio: 'ignore' }
    );
  } catch {
    // Best-effort — a repo without the file tracked just can't be skipped.
  }
};

const packageIsModule = (appDir: string): boolean => {
  try {
    return (
      (JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
        type?: string;
      }).type === 'module'
    );
  } catch {
    return false;
  }
};

/**
 * Inject the AI analyzer into a client clone for the PREVIEW ONLY. Returns a
 * BootPlan describing how to spawn the tagged dev server, or null when the
 * framework isn't recognized (the caller then spawns plainly, no tagging).
 *
 * Nothing here is committable:
 *  - the analyzer folder is copied under `<appDir>/ai-analyzer/` and the repo
 *    root's `.git/info/exclude` is extended so git never sees it (belt-and-
 *    braces beyond the client's own .gitignore), and
 *  - the real config is never modified — Astro/Vite import it via the dev
 *    server's `--config` wrapper, and Next loads it read-only in a programmatic
 *    server — so `discardChanges` (git reset --hard) has nothing to revert and
 *    `git add -A` has nothing to stage.
 */
export const injectAnalyzer = (dir: string, appDir: string): BootPlan | null => {
  if (!existsSync(ANALYZER_SRC)) return null;
  const framework = detectFramework(appDir);
  if (!framework) return null;

  const destDir = join(appDir, 'ai-analyzer');
  cpSync(ANALYZER_SRC, destDir, { recursive: true });

  const exclude = () => {
    ensureGitExclude(dir, 'ai-analyzer/');
    if (appDir !== dir) {
      const rel = appDir.slice(dir.length).replace(/^\/+/, '');
      ensureGitExclude(dir, `${rel}/ai-analyzer/`);
    }
  };

  if (framework === 'astro') {
    const configName = findAstroConfig(appDir);
    // `astro` dep but no config file — nothing to wrap; boot plainly.
    if (!configName) return null;
    writeFileSync(join(destDir, 'preview.config.mjs'), astroWrapper(configName));
    exclude();
    return { framework: 'astro', configPath: 'ai-analyzer/preview.config.mjs' };
  }

  if (framework === 'vite') {
    writeFileSync(
      join(destDir, 'preview.vite.config.mjs'),
      viteWrapper(findViteConfig(appDir))
    );
    exclude();
    return {
      framework: 'vite',
      configPath: 'ai-analyzer/preview.vite.config.mjs',
    };
  }

  // Next: overwrite next.config on disk with a wrapper that imports the client's
  // real config (backed up under ai-analyzer/) and adds our webpack loader.
  // skip-worktree keeps git blind to the overwrite, so it can't reach a publish;
  // on a warm clone the backup already exists and re-wrapping is idempotent.
  const cfgName = findNextConfig(appDir);
  if (cfgName) {
    const ext = extname(cfgName);
    const cjs = ext === '.cjs' || (ext === '.js' && !packageIsModule(appDir));
    const backupName = `client-next-config${ext}`;
    if (!existsSync(join(destDir, backupName))) {
      cpSync(join(appDir, cfgName), join(destDir, backupName));
    }
    writeFileSync(
      join(appDir, cfgName),
      nextWrapper(`./ai-analyzer/${backupName}`, cjs)
    );
    gitSkipWorktree(appDir, cfgName, true);
  } else {
    // No config file (next dep only): standalone wrapper, untracked → excluded.
    writeFileSync(join(appDir, 'next.config.mjs'), nextWrapper(null, false));
    const rel = appDir === dir ? '' : `${appDir.slice(dir.length).replace(/^\/+/, '')}/`;
    ensureGitExclude(dir, `${rel}next.config.mjs`);
  }
  exclude();
  return { framework: 'next' };
};
