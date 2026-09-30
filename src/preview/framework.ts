import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Which framework a client clone runs, and how to boot its dev server with the
 * AI-analyzer source tagger injected. Two real boot paths:
 *  - Vite (astro, tanstack start, vanilla vite + react) — a single injected
 *    Vite plugin stamps `data-cms-src`, booted via a `--config` wrapper.
 *  - Next — its own compiler; the tagger rides a webpack loader through a
 *    programmatic dev server (see ai-analyzer/preview-next-server.mjs).
 * Anything unrecognized returns null and boots plainly with no tagging.
 */
export type Framework = 'astro' | 'next' | 'vite';

export type BootPlan =
  | { framework: 'astro'; configPath: string; extraEnv?: Record<string, string> }
  | { framework: 'vite'; configPath: string; extraEnv?: Record<string, string> }
  | { framework: 'next'; extraEnv?: Record<string, string> };

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

const firstExisting = (appDir: string, names: string[]): string | null => {
  for (const name of names) {
    if (existsSync(join(appDir, name))) return name;
  }
  return null;
};

export const findAstroConfig = (appDir: string) =>
  firstExisting(appDir, ASTRO_CONFIGS);
export const findViteConfig = (appDir: string) =>
  firstExisting(appDir, VITE_CONFIGS);
export const findNextConfig = (appDir: string) =>
  firstExisting(appDir, NEXT_CONFIGS);

const readDeps = (appDir: string): Record<string, string> => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(appDir, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
};

/**
 * Precedence matters: Astro and TanStack Start both pull in `vite`, so Astro and
 * Next (each with a distinctive config/dep) are matched first, and the generic
 * Vite bucket catches everything else that runs on Vite.
 */
export const detectFramework = (appDir: string): Framework | null => {
  const deps = readDeps(appDir);
  if (findAstroConfig(appDir) || deps.astro) return 'astro';
  if (findNextConfig(appDir) || deps.next) return 'next';
  if (
    findViteConfig(appDir) ||
    deps.vite ||
    deps['@tanstack/react-start'] ||
    deps['@tanstack/start']
  )
    return 'vite';
  return null;
};
