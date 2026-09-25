import {
  appendFileSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

// The maintained source-of-truth folder, copied into each client clone. The
// supervisor runs from the content-pilot repo root (tsx src/preview/index.ts),
// so cwd is the repo root in both local dev and the container (WORKDIR /app).
const ANALYZER_SRC = join(process.cwd(), 'ai-analyzer');

const CONFIG_NAMES = [
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.mts',
  'astro.config.js',
  'astro.config.cjs',
];

const findAstroConfig = (appDir: string): string | null => {
  for (const name of CONFIG_NAMES) {
    if (existsSync(join(appDir, name))) return name;
  }
  return null;
};

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

/**
 * Inject the AI analyzer into a client clone for the PREVIEW ONLY. Returns the
 * `--config` path (relative to appDir) to hand the dev server, or null when the
 * repo isn't Astro (the caller then spawns normally).
 *
 * Nothing here is committable:
 *  - the analyzer folder is copied under `<appDir>/ai-analyzer/` and the repo
 *    root's `.git/info/exclude` is extended so git never sees it (belt-and-
 *    braces beyond the client's own .gitignore), and
 *  - the real astro.config is never modified — the wrapper imports it via the
 *    dev server's `--config` flag, so `discardChanges` (git reset --hard) has
 *    nothing to revert and `git add -A` has nothing to stage.
 */
export const injectAnalyzer = (dir: string, appDir: string): string | null => {
  if (!existsSync(ANALYZER_SRC)) return null;
  const configName = findAstroConfig(appDir);
  if (!configName) return null;

  const destDir = join(appDir, 'ai-analyzer');
  cpSync(ANALYZER_SRC, destDir, { recursive: true });

  // Wrapper config: extend the client's real config, drop its committed
  // cms-bridge integration, add the analyzer. Exactly one integration then
  // annotates — no double build.
  const wrapper = `import base from ${JSON.stringify(`../${configName}`)};
import aiAnalyzer from './integration.mjs';

const list = (base.integrations ?? []).filter((i) => i?.name !== 'cms-bridge');
export default { ...base, integrations: [...list, aiAnalyzer({})] };
`;
  writeFileSync(join(destDir, 'preview.config.mjs'), wrapper);

  ensureGitExclude(dir, 'ai-analyzer/');
  if (appDir !== dir) {
    const rel = appDir.slice(dir.length).replace(/^\/+/, '');
    ensureGitExclude(dir, `${rel}/ai-analyzer/`);
  }

  return 'ai-analyzer/preview.config.mjs';
};
