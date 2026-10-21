import { execFile } from 'child_process';
import { promisify } from 'util';
import { client } from '@/db';
import { listAllDomainMappings } from '@/lib/settings';
import { ensureWorkspace } from '../worker/config';
import { checkAiAvailability } from './ai-availability';
import { writeGeminiRuntime } from './gemini-setup';
import { previewConfig } from './config';
import { createDomainMap } from './domain-map';
import { drainLiveBuilds, requeueInterruptedBuilds } from './live-build';
import { startProxy } from './proxy';
import {
  bootReconcile,
  pruneOrphanEvents,
  reconcileTick,
  sweepIdle,
} from './reconcile';

const execFileAsync = promisify(execFile);

const log = (message: string) => {
  console.log(`[${new Date().toISOString()}] [preview] ${message}`);
};

// Interruptible sleep — a NOTIFY on cp_preview (new session, new message,
// close request) wakes the loop immediately instead of waiting the poll.
let wake: (() => void) | null = null;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

const main = async () => {
  ensureWorkspace();
  await execFileAsync('git', ['--version']);
  // Previews don't need Anthropic — only chat runs do. A missing/invalid key
  // never blocks boot; it just disables AI chat with an instant per-message
  // error (see ai-availability.ts).
  await checkAiAvailability(log);
  // Gemini sessions run from an isolated config home: trimmed tool set, no
  // narration/dir tree, LOW thinking, plus the deny policy (no shell/network).
  writeGeminiRuntime(log);

  // Custom-domain serving map (host -> repoId): loaded before the proxy takes
  // traffic, refreshed on cp_domains NOTIFY + a 60s interval safety net.
  const domainMap = createDomainMap({ load: listAllDomainMappings });
  await domainMap.start();

  startProxy(previewConfig.proxyPort, { resolveDomain: domainMap.resolve });
  log(
    `proxy listening on :${previewConfig.proxyPort} — preview base ${previewConfig.urlBase}, max ${previewConfig.maxSessions} sessions, idle TTL ${previewConfig.idleMinutes}m`
  );

  await bootReconcile();
  // Live-site builds: resume any interrupted by a restart, then drain on
  // cp_build NOTIFY (publish/import) plus the slow-pass safety net below.
  await requeueInterruptedBuilds();
  void drainLiveBuilds();

  await client.listen('cp_preview', () => {
    if (wake) wake();
  });
  await client.listen('cp_build', () => {
    void drainLiveBuilds();
  });
  await client.listen('cp_domains', () => {
    void domainMap.refresh();
  });

  let lastSlowPass = 0;
  while (true) {
    try {
      await reconcileTick();
      if (Date.now() - lastSlowPass > 60_000) {
        lastSlowPass = Date.now();
        await sweepIdle();
        await pruneOrphanEvents();
        void drainLiveBuilds();
      }
    } catch (error) {
      log(`tick failed: ${(error as Error).message}`);
    }
    await sleep(2_000);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
