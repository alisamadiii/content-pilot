import { readdir, readFile, stat } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { listImageDirHints, publicRelFor } from './image-dirs';
import { detectFramework, type Framework } from './framework';

/**
 * Cheap, deterministic facts about a client repo that the agent would
 * otherwise discover with tool calls on every message: which file renders each
 * page, which CMS files exist, where images live, which components exist. Built
 * from the filesystem in milliseconds (no AI tokens) and injected into the
 * system prompt; `routes` also drives pin-by-page (see prompt-context).
 *
 * All paths are repo-root-relative with forward slashes, matching the hub's
 * `data-cms-src` refs and the prompt wording.
 */
export type RepoContext = {
  framework: Framework | null;
  /** Page path (`/about`) → repo-relative source file (`src/pages/about.astro`). */
  routes: Map<string, string>;
  /** Repo-relative component/section files, capped. */
  components: string[];
  cmsFiles: string[];
  imageDirs: Array<{ dir: string; count: number }>;
  publicRel: string;
  /** Developer notes (AGENTS.md / CLAUDE.md), capped; '' when absent. */
  agentNotes: string;
  /** Prompt block: site facts + developer notes. */
  text: string;
};

/**
 * Developer-authored repo rules. AGENTS.md wins over CLAUDE.md (same content
 * in practice); repo root wins over the app folder. Inlined once into the
 * system prompt so the model never spends a tool call re-reading it per
 * message. Capped: these files are rules, not manuals.
 */
export const MAX_AGENT_NOTES_CHARS = 6_000;
const readAgentNotes = async (dir: string, appDir: string): Promise<string> => {
  for (const base of dir === appDir ? [dir] : [dir, appDir]) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      try {
        const raw = (await readFile(join(base, name), 'utf8')).trim();
        if (!raw) continue;
        return raw.length > MAX_AGENT_NOTES_CHARS
          ? `${raw.slice(0, MAX_AGENT_NOTES_CHARS)}\n…(truncated)`
          : raw;
      } catch {
        // next candidate
      }
    }
  }
  return '';
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.astro',
  '.next',
  'ai-analyzer',
]);
const COMPONENT_LIST_CAP = 40;
const toPosix = (path: string) => path.split('\\').join('/');

/** Recursive file walk (repo-relative posix paths), bounded + skipping junk. */
const walkFiles = async (
  root: string,
  dir: string,
  depth: number,
  out: string[],
  cap: number
) => {
  if (depth > 6 || out.length >= cap) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(root, join(dir, entry.name), depth + 1, out, cap);
    } else if (entry.isFile()) {
      out.push(toPosix(relative(root, join(dir, entry.name))));
    }
  }
};

const exists = async (path: string) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const PAGE_EXT = /\.(astro|md|mdx|html)$/;
const NEXT_PAGE = /(^|\/)page\.(tsx|jsx|ts|js|mdx)$/;
const NEXT_PAGES_SKIP = /(^|\/)(_app|_document|_error|api\/)/;
const NEXT_PAGES_EXT = /\.(tsx|jsx|ts|js|mdx)$/;

const stripExt = (file: string) => file.replace(/\.[^./]+$/, '');
const toRoute = (segments: string[]) => {
  const route = '/' + segments.filter(Boolean).join('/');
  return route === '/' ? '/' : route.replace(/\/index$/, '') || '/';
};

/**
 * Framework routing conventions → page path map. Dynamic segments stay literal
 * (`/events/[slug]`); `resolvePageFile` matches them by pattern.
 */
export const collectRoutes = async (
  dir: string,
  appDir: string,
  framework: Framework | null
): Promise<Map<string, string>> => {
  const routes = new Map<string, string>();
  const appRel = toPosix(relative(dir, appDir));
  const rel = (p: string) => (appRel ? `${appRel}/${p}` : p);
  const add = (route: string, file: string) => {
    if (!routes.has(route)) routes.set(route, rel(file));
  };

  if (framework === 'astro') {
    const files: string[] = [];
    await walkFiles(appDir, join(appDir, 'src', 'pages'), 0, files, 400);
    for (const file of files) {
      if (!PAGE_EXT.test(file)) continue;
      const inner = file.replace(/^src\/pages\//, '');
      add(toRoute(stripExt(inner).split('/')), file);
    }
    return routes;
  }

  if (framework === 'next') {
    for (const appRoot of ['src/app', 'app']) {
      const files: string[] = [];
      await walkFiles(appDir, join(appDir, appRoot), 0, files, 400);
      for (const file of files) {
        if (!NEXT_PAGE.test(file)) continue;
        const inner = dirname(file.replace(`${appRoot}/`, ''));
        const segments = (inner === '.' ? [] : inner.split('/')).filter(
          (segment) => !/^\(.*\)$/.test(segment) && !/^@/.test(segment)
        );
        add(toRoute(segments), file);
      }
    }
    for (const pagesRoot of ['src/pages', 'pages']) {
      const files: string[] = [];
      await walkFiles(appDir, join(appDir, pagesRoot), 0, files, 400);
      for (const file of files) {
        const inner = file.replace(`${pagesRoot}/`, '');
        if (!NEXT_PAGES_EXT.test(inner) || NEXT_PAGES_SKIP.test(inner)) continue;
        add(toRoute(stripExt(inner).split('/')), file);
      }
    }
    return routes;
  }

  // Vite / static / unknown: a single index.html (or src/index.html).
  for (const candidate of ['index.html', 'src/index.html']) {
    if (await exists(join(appDir, candidate))) {
      add('/', candidate);
      break;
    }
  }
  return routes;
};

/** Exact match first, then dynamic-segment patterns (`[slug]`, `[...rest]`). */
export const resolvePageFile = (
  routes: Map<string, string>,
  pagePath: string
): string | null => {
  const path = pagePath.replace(/\/+$/, '') || '/';
  const exact = routes.get(path);
  if (exact) return exact;
  for (const [route, file] of routes) {
    if (!route.includes('[')) continue;
    const pattern =
      '^' +
      route
        .split('/')
        .map((segment) =>
          /^\[\.\.\./.test(segment)
            ? '.+'
            : /^\[.*\]$/.test(segment)
              ? '[^/]+'
              : segment.replace(/[.*+?^${}()|\\]/g, '\\$&')
        )
        .join('/') +
      '$';
    if (new RegExp(pattern).test(path)) return file;
  }
  return null;
};

const HOME_WORDS = /\b(home ?page|landing page|front page|main page)\b/i;

/**
 * A page the message names explicitly ("the about page", "on contact") wins
 * over the page the client happens to be viewing. Longest segment wins; the
 * current page is never returned (the caller already has it).
 */
export const routeMentionedIn = (
  message: string,
  routes: Map<string, string>,
  currentPath: string
): string | null => {
  const text = message.toLowerCase();
  if (currentPath !== '/' && routes.has('/') && HOME_WORDS.test(text)) return '/';
  let best: { route: string; length: number } | null = null;
  for (const route of routes.keys()) {
    if (route === '/' || route === currentPath || route.includes('[')) continue;
    const segment = route.split('/').pop() ?? '';
    if (segment.length < 3) continue;
    const word = segment.replace(/[-_]/g, '[-_ ]?');
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      if (!best || segment.length > best.length) {
        best = { route, length: segment.length };
      }
    }
  }
  return best?.route ?? null;
};

const listComponents = async (dir: string, appDir: string) => {
  const appRel = toPosix(relative(dir, appDir));
  const out: string[] = [];
  for (const folder of ['src/components', 'src/sections', 'components']) {
    const files: string[] = [];
    await walkFiles(appDir, join(appDir, folder), 0, files, COMPONENT_LIST_CAP);
    for (const file of files) {
      if (!/\.(astro|tsx|jsx|vue|svelte)$/.test(file)) continue;
      if (/(^|\/)ui\//.test(file)) continue; // design-system primitives
      out.push(appRel ? `${appRel}/${file}` : file);
      if (out.length >= COMPONENT_LIST_CAP) return out;
    }
  }
  return out;
};

const listCmsFiles = async (dir: string) => {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of ['_site.json', '_pages.json']) {
    if (names.includes(name)) out.push(name);
  }
  if (names.includes('_collections')) {
    try {
      const files = (await readdir(join(dir, '_collections')))
        .filter((f) => f.endsWith('.json'))
        .sort();
      for (const f of files.slice(0, 20)) out.push(`_collections/${f}`);
    } catch {
      // ignore
    }
  }
  return out;
};

const renderText = (ctx: Omit<RepoContext, 'text'>) => {
  const lines: string[] = ['# This site'];
  lines.push(
    `Framework: ${ctx.framework ?? 'static'}. Public folder for images: \`${ctx.publicRel}/\` (served at \`/\`).`
  );
  if (ctx.routes.size) {
    lines.push('Pages and the file that renders each one:');
    const entries = [...ctx.routes.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [route, file] of entries.slice(0, 40)) {
      lines.push(`- ${route} → ${file}`);
    }
    if (entries.length > 40) lines.push(`- … ${entries.length - 40} more`);
  }
  if (ctx.cmsFiles.length) {
    lines.push(`CMS JSON files at the repo root: ${ctx.cmsFiles.map((f) => `\`${f}\``).join(', ')}.`);
  }
  if (ctx.components.length) {
    lines.push(`Components: ${ctx.components.join(', ')}`);
  }
  if (ctx.imageDirs.length) {
    lines.push(
      `Image folders: ${ctx.imageDirs
        .slice(0, 8)
        .map((h) => `\`${h.dir}\` (${h.count})`)
        .join(', ')}.`
    );
  }
  if (ctx.agentNotes) {
    lines.push(
      '',
      "# Developer notes for this site (from the repo's AGENTS.md — already included here, never read that file, CLAUDE.md or README again)",
      'Follow these where they concern content, data files and conventions; ignore anything about running commands, dev servers, builds or installing packages.',
      '',
      ctx.agentNotes
    );
  }
  return lines.join('\n');
};

export const buildRepoContext = async (
  dir: string,
  appDir: string
): Promise<RepoContext> => {
  const framework = detectFramework(appDir);
  const publicRel = publicRelFor(dir, appDir);
  const [routes, components, cmsFiles, imageDirs, agentNotes] = await Promise.all([
    collectRoutes(dir, appDir, framework),
    listComponents(dir, appDir),
    listCmsFiles(dir),
    listImageDirHints(appDir, publicRel),
    readAgentNotes(dir, appDir),
  ]);
  const partial = {
    framework,
    routes,
    components,
    cmsFiles,
    imageDirs,
    publicRel,
    agentNotes,
  };
  return { ...partial, text: renderText(partial) };
};

// ---------------------------------------------------------------------------
// Page bundle: a page file plus the local components it imports, for pinning.
// ---------------------------------------------------------------------------

const IMPORT_RE = /import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const RESOLVE_EXTS = ['', '.astro', '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.mdx', '.md'];
/** Content lives in components/sections/data; layouts, libs and UI kits do not. */
const PIN_WORTHY = /(^|\/)(src\/)?(components|sections|data|content)\//;
const PIN_SKIP = /(^|\/)(ui|icons)\//;

const resolveImport = async (
  spec: string,
  fromFile: string,
  dir: string,
  appDir: string
): Promise<string | null> => {
  let base: string;
  if (spec.startsWith('@/') || spec.startsWith('~/')) {
    base = join(appDir, 'src', spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    base = join(dir, dirname(fromFile), spec);
  } else {
    return null; // package or virtual module
  }
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (await exists(candidate)) return toPosix(relative(dir, candidate));
  }
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const candidate = join(base, `index${ext}`);
    if (await exists(candidate)) return toPosix(relative(dir, candidate));
  }
  return null;
};

export type PageBundle = {
  files: Array<{ path: string; content: string }>;
  /** Imports that exist but were left out (budget or not content-bearing). */
  omitted: string[];
};

/**
 * The page file first, then the content-bearing files it imports directly
 * (components/sections/data), in import order, until `budget` chars are used.
 * Pages are often just a list of section components, so without this the
 * agent re-discovers the component on every request.
 */
export const collectPageBundle = async (
  dir: string,
  appDir: string,
  pageFile: string,
  budget: number
): Promise<PageBundle | null> => {
  let page: string;
  try {
    page = await readFile(join(dir, pageFile), 'utf8');
  } catch {
    return null;
  }
  if (page.length > budget) return null;
  const files: PageBundle['files'] = [{ path: pageFile, content: page }];
  const omitted: string[] = [];
  let used = page.length;
  const seen = new Set([pageFile]);
  for (const match of page.matchAll(IMPORT_RE)) {
    const resolved = await resolveImport(match[1], pageFile, dir, appDir);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    if (!PIN_WORTHY.test(resolved) || PIN_SKIP.test(resolved)) continue;
    let content: string;
    try {
      content = await readFile(join(dir, resolved), 'utf8');
    } catch {
      continue;
    }
    if (used + content.length > budget) {
      omitted.push(resolved);
      continue;
    }
    used += content.length;
    files.push({ path: resolved, content });
  }
  return { files, omitted };
};
