import { verifyApiKey } from '@/lib/api-key';
import { isProjectId } from '@/lib/project-id';
import { extractCredentials } from '@/lib/request-credentials';
import { latestDeploy } from '@/deploy/queue';

export const runtime = 'nodejs';

/** Server-to-server (x-api-key only): the project's latest Netlify deploy job. */
export const GET = async (
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) => {
  const { apiKeyCandidate } = extractCredentials(request);
  if (!(await verifyApiKey(apiKeyCandidate))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { projectId } = await params;
  if (!isProjectId(projectId)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }
  return Response.json({ deploy: await latestDeploy(projectId) });
};
