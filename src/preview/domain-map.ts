/**
 * In-memory host -> repoId map for the preview proxy. The proxy resolves every
 * request's Host header against it, so it must never hit the DB per request:
 * the supervisor loads it at boot, refreshes on the `cp_domains` NOTIFY (sent
 * by every mapping write), and re-loads on an interval as a safety net.
 *
 * The loader is injected so proxy/domain tests run without a DATABASE_URL.
 */

export type DomainResolver = (host: string) => number | null;

export interface DomainMap {
  resolve: DomainResolver;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
}

export const createDomainMap = (options: {
  load: () => Promise<Map<string, number>>;
  refreshMs?: number;
}): DomainMap => {
  let current = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  const refreshMs = options.refreshMs ?? 60_000;

  const refresh = async () => {
    try {
      // Atomic swap: readers only ever see a complete map.
      current = await options.load();
    } catch (error) {
      // Keep serving the old map — a DB blip must not take live sites down.
      console.error('[domain-map] refresh failed', error);
    }
  };

  return {
    resolve: (host) => current.get(host) ?? null,
    refresh,
    start: async () => {
      await refresh();
      timer = setInterval(() => void refresh(), refreshMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};
