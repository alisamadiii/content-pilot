import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Which kind of static site a client project is. Content Pilot hosts static
 * output only — every published site is a folder of files served from disk:
 *  - astro  — Astro with static output (React/MDX/etc. integrations fine);
 *             previewed via `astro dev`, published via `astro build` → dist/.
 *  - vite   — a plain Vite app (React/Vue/vanilla SPA or MPA); previewed via
 *             `vite dev`, published via `vite build` → dist/.
 *  - static — a plain HTML/CSS/JS repo with no package.json at all, served by
 *             the PILOT's own Vite in preview and published as-is (no build).
 * Everything else (Next.js, SSR meta-frameworks, unknown stacks) is rejected
 * at import time — see checkFramework.
 */
export type Framework = 'astro' | 'vite' | 'static';

export type BootPlan = {
  framework: Framework;
  configPath: string;
  extraEnv?: Record<string, string>;
};

const ASTRO_CONFIGS = [
  'astro.config.mjs',
  'astro.config.ts',
  'astro.config.mts',
  'astro.config.js',
  'astro.config.cjs',
];

const VITE_CONFIGS = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'vite.config.mjs',
  'vite.config.cts',
  'vite.config.cjs',
];

const NEXT_CONFIGS = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'next.config.cjs',
];

// Server-rendering frameworks that ride on Vite but don't build to a static
// dist/ — a plain `vite build` of these never yields a servable site.
const SSR_DEPS = [
  'next',
  'nuxt',
  '@sveltejs/kit',
  '@remix-run/dev',
  '@react-router/dev',
  '@tanstack/react-start',
  '@tanstack/start',
  '@solidjs/start',
  '@builder.io/qwik-city',
];

const firstExisting = (dir: string, names: string[]): string | null => {
  for (const name of names) {
    if (existsSync(join(dir, name))) return name;
  }
  return null;
};

export const findAstroConfig = (dir: string) =>
  firstExisting(dir, ASTRO_CONFIGS);
export const findViteConfig = (dir: string) =>
  firstExisting(dir, VITE_CONFIGS);

const readDeps = (dir: string): Record<string, string> => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
};

export type UnsupportedReason = 'next' | 'ssr' | 'astro_server' | 'unknown';

export type FrameworkCheck =
  | { ok: true; framework: Framework }
  | { ok: false; reason: UnsupportedReason; message: string };

export const UNSUPPORTED_MESSAGES: Record<UnsupportedReason, string> = {
  next: "Next.js projects aren't supported. Content Pilot hosts static sites: Astro, Vite, or plain HTML.",
  ssr: "Server-rendered frameworks aren't supported. Content Pilot hosts static sites: Astro, Vite, or plain HTML.",
  astro_server:
    "This Astro project uses server output (output: 'server'). Content Pilot hosts static sites only, so switch to static output.",
  unknown:
    "We couldn't find an Astro, Vite, or plain HTML site here. Content Pilot hosts static sites: Astro, Vite, or plain HTML.",
};

const reject = (reason: UnsupportedReason): FrameworkCheck => ({
  ok: false,
  reason,
  message: UNSUPPORTED_MESSAGES[reason],
});

/** Astro config declaring server output — needs a runtime, can't be static. */
const astroServerOutput = (dir: string, configName: string | null) => {
  if (!configName) return false;
  try {
    const source = readFileSync(join(dir, configName), 'utf8');
    return /output\s*:\s*['"`](server|hybrid)['"`]/.test(source);
  } catch {
    return false;
  }
};

/**
 * The import gate: is this a project Content Pilot can preview AND publish as
 * static files? Precedence matters — static (no package.json) first, so a stray
 * config file can't route a toolchain-less repo onto an install path; Astro
 * before Vite because Astro pulls in vite as a dependency.
 */
export const checkFramework = (dir: string): FrameworkCheck => {
  const hasPkg = existsSync(join(dir, 'package.json'));
  if (!hasPkg) {
    return existsSync(join(dir, 'index.html'))
      ? { ok: true, framework: 'static' }
      : reject('unknown');
  }
  const deps = readDeps(dir);
  if (firstExisting(dir, NEXT_CONFIGS) || deps.next) return reject('next');
  const astroConfig = findAstroConfig(dir);
  if (astroConfig || deps.astro) {
    return astroServerOutput(dir, astroConfig)
      ? reject('astro_server')
      : { ok: true, framework: 'astro' };
  }
  if (SSR_DEPS.some((dep) => deps[dep])) return reject('ssr');
  if (findViteConfig(dir) || deps.vite) return { ok: true, framework: 'vite' };
  return reject('unknown');
};

/** The supported framework, or null for anything checkFramework rejects. */
export const detectFramework = (dir: string): Framework | null => {
  const check = checkFramework(dir);
  return check.ok ? check.framework : null;
};
