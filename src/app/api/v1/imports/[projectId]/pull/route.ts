import { existsSync } from 'fs';
import { mkdir, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-key';
import { closeProjectSessions } from '@/lib/close-project-sessions';
import { isProjectId } from '@/lib/project-id';
import { extractCredentials } from '@/lib/request-credentials';
import {
  dropFetchedBackup,
  exportFetchedBackup,
  fetchBackup,
  isBackupConfigured,
  isBackupRepoName,
  mirrorBackup,
} from '@/worker/backup';
import { ensureWorkspace } from '@/worker/config';
import { hasOrigin, repoDir } from '@/worker/git';
import { acquireReplaceLock, importsRoot } from '@/worker/replace';
import { ZipError } from '@/worker/zip-extract';
import { checkFramework } from '@/preview/framework';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only): make an upload project's workspace
 * `main` the latest commit of its GitHub backup repo (hub "GitHub" dialog,
 * "Pull latest commit"). The reverse of /backup: someone edited the repo on
 * GitHub, the workspace follows. The workspace main is hard-reset to that
 * commit, so history matches GitHub exactly and nothing needs pushing back.
 *
 * Body: { repo, sha? }. `sha` is what the dialog showed; a different head on
 * GitHub answers 409 stale_head so nobody pulls a commit they never saw.
 * Shares the replace lock, the 409-while-booting rule and the framework gate
 * with the zip replace.
 */

const bodySchema = z.object({
  repo: z.string().refine(isBackupRepoName),
  sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});

export const POST = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  const { apiKeyCandidate } = extractCredentials(request);
  if (!(await verifyApiKey(apiKeyCandidate))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const projectId = (await params).projectId;
  if (!isProjectId(projectId)) {
    return Response.json({ error: 'Invalid projectId' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }
  if (!isBackupConfigured()) {
    return Response.json({ error: 'Backups are not configured.' }, { status: 503 });
  }
  const dir = repoDir(projectId);
  if (!existsSync(join(dir, '.git'))) {
    return Response.json(
      { error: "This project's files are missing from the preview server." },
      { status: 404 }
    );
  }
  if (await hasOrigin(dir)) {
    return Response.json({ error: 'GitHub projects update through GitHub.' }, { status: 400 });
  }

  ensureWorkspace();
  const release = await acquireReplaceLock(projectId);
  if (!release) {
    return Response.json(
      { error: 'Another import is already running for this project.' },
      { status: 409 }
    );
  }

  const stamp = Date.now();
  const zipPath = join(importsRoot(), `${projectId}-p${stamp}.zip`);
  const staging = join(importsRoot(), `${projectId}-p${stamp}`);
  let fetched = false;

  try {
    await mkdir(importsRoot(), { recursive: true });
    let head;
    try {
      head = await fetchBackup(projectId, parsed.data.repo);
      fetched = true;
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Fetch from GitHub failed.' },
        { status: 502 }
      );
    }
    if (parsed.data.sha && parsed.data.sha !== head.sha) {
      return Response.json(
        {
          error: 'GitHub moved on since you opened this. Reopen and try again.',
          code: 'stale_head',
          sha: head.sha,
        },
        { status: 409 }
      );
    }

    // Same gate as import and replace, on a copy of the tree: an unsupported
    // commit leaves the current workspace exactly as it was.
    const { files } = await exportFetchedBackup(projectId, zipPath, staging);
    if (!files || !(await readdir(staging)).length) {
      return Response.json({ error: 'That commit has no files.' }, { status: 422 });
    }
    const check = checkFramework(staging);
    if (!check.ok) {
      return Response.json(
        { error: check.message, code: 'unsupported_framework', reason: check.reason },
        { status: 422 }
      );
    }

    const closed = await closeProjectSessions(projectId, 'Replaced by a pull from GitHub.');
    if (closed.booting) {
      return Response.json(
        { error: 'The editor is starting up for this project. Try again in a minute.' },
        { status: 409 }
      );
    }

    const { sha } = await mirrorBackup(projectId, parsed.data.repo);
    fetched = false; // mirrorBackup dropped the ref
    return Response.json({ projectId, sha, message: head.message, framework: check.framework });
  } catch (error) {
    if (error instanceof ZipError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error('[imports] pull failed', error);
    return Response.json(
      { error: 'Pull failed. The current site was not changed.' },
      { status: 500 }
    );
  } finally {
    if (fetched) await dropFetchedBackup(projectId);
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await release();
  }
};
