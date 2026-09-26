import { execFile } from 'child_process';
import { promisify } from 'util';
import { client } from '@/db';
import { config as workerConfig, ensureWorkspace } from '../worker/config';
import { previewConfig } from './config';
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
  await execFileAsync(workerConfig.claudeBin, ['--version']).catch(() => {
    throw new Error(
      `Claude Code CLI not found ("${workerConfig.claudeBin}"). Install it and run "claude login".`
    );
  });

  startProxy();
  log(
    `proxy listening on :${previewConfig.proxyPort} — preview base ${previewConfig.urlBase}, max ${previewConfig.maxSessions} sessions, idle TTL ${previewConfig.idleMinutes}m`
  );

  await bootReconcile();

  await client.listen('cp_preview', () => {
    if (wake) wake();
  });

  let lastSlowPass = 0;
  while (true) {
    try {
      await reconcileTick();
      if (Date.now() - lastSlowPass > 60_000) {
        lastSlowPass = Date.now();
        await sweepIdle();
        await pruneOrphanEvents();
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
