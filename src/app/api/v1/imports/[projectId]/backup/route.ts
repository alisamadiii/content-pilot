import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-key';
import { isProjectId } from '@/lib/project-id';
import { extractCredentials } from '@/lib/request-credentials';
import { isBackupConfigured, isBackupRepoName, queueBackup } from '@/worker/backup';
import { hasOrigin, repoDir } from '@/worker/git';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only): push an upload project's `main` to the
 * backup org repo the hub names. The hub calls it after a source replace and
 * after an admin links a different repo. Fire-and-forget: 202 once queued,
 * the result shows up in GET /imports/:projectId `backup`.
 */

const bodySchema = z.object({ repo: z.string().refine(isBackupRepoName) });

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
    return Response.json({ error: 'Workspace missing.' }, { status: 404 });
  }
  if (await hasOrigin(dir)) {
    return Response.json({ error: 'GitHub projects are not backed up.' }, { status: 400 });
  }
  void queueBackup(projectId, parsed.data.repo);
  return Response.json({ queued: true }, { status: 202 });
};
