import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { verifyApiKey } from '@/lib/api-key';
import { isProjectId } from '@/lib/project-id';
import { extractCredentials } from '@/lib/request-credentials';
import { enqueueDeploy } from '@/deploy/queue';
import { repoDir } from '@/worker/git';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only): queue a build + Netlify deploy of an
 * upload project's default branch. Answers 202 at once; the hub reads progress
 * from GET /api/v1/deploys/<projectId>. The token is held in memory only.
 */

const body = z.object({
  projectId: z.string().refine(isProjectId),
  siteId: z.string().min(1).max(100),
  token: z.string().min(1).max(500),
});

export const POST = async (request: Request) => {
  const { apiKeyCandidate } = extractCredentials(request);
  if (!(await verifyApiKey(apiKeyCandidate))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!existsSync(join(repoDir(parsed.data.projectId), '.git'))) {
    return Response.json(
      { error: "This project's files are missing from the server." },
      { status: 422 }
    );
  }
  const deploy = await enqueueDeploy(parsed.data);
  return Response.json({ deploy }, { status: 202 });
};
