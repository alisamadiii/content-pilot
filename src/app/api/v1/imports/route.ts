import { isProjectId } from '@/lib/project-id';
import { existsSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { verifyApiKey } from '@/lib/api-key';
import {
  authorFromHeaders,
  declaredTooLarge,
  receiveZip,
} from '@/lib/import-upload';
import { verifyImportToken } from '@/lib/import-token';
import { extractCredentials, sessionCorsHeaders } from '@/lib/request-credentials';
import { config, ensureWorkspace } from '@/worker/config';
import { git, repoDir } from '@/worker/git';
import { importsRoot } from '@/worker/replace';
import { extractZip, stripWrapperDir, ZipError } from '@/worker/zip-extract';
import { checkFramework } from '@/preview/framework';

export const runtime = 'nodejs';

/**
 * Project import for uploaded (no-GitHub) projects: the hub mints a one-time
 * import token bound to the new project id, the browser POSTs the zip
 * straight here (Vercel's body cap rules out proxying through the hub), and
 * the extracted tree becomes a local-only git workspace — `git init`, branch
 * `main`, one initial commit. Only static sites get in (Astro, Vite, plain
 * HTML) — anything else is refused before the workspace exists. Uploaded
 * projects are preview-only: publish commits locally, nothing deploys.
 *
 * The body is a raw zip stream (`Content-Type: application/zip`), never
 * multipart: `request.formData()` would buffer the whole archive in memory.
 */

export const OPTIONS = async (request: Request) =>
  new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });

const authenticate = async (request: Request, projectId: string) => {
  const { apiKeyCandidate, editTokenCandidate } = extractCredentials(request);
  if (await verifyApiKey(apiKeyCandidate)) return true;
  const token = verifyImportToken(editTokenCandidate, 'import');
  return token !== null && token.projectId === projectId;
};

export const POST = async (request: Request) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') ?? '';
  const name = (url.searchParams.get('name') || 'site').slice(0, 100);
  if (!isProjectId(projectId)) {
    return Response.json({ error: 'projectId required' }, { status: 400, headers });
  }

  if (!(await authenticate(request, projectId))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const dir = repoDir(projectId);
  if (existsSync(dir)) {
    // Also what makes the import token effectively single-use.
    return Response.json(
      { error: 'This project was already imported.' },
      { status: 409, headers }
    );
  }

  if (declaredTooLarge(request)) {
    return Response.json(
      { error: 'Zip is larger than 100 MB.' },
      { status: 413, headers }
    );
  }
  if (!request.body) {
    return Response.json({ error: 'Empty body' }, { status: 400, headers });
  }

  ensureWorkspace();
  const zipPath = join(importsRoot(), `${projectId}.zip`);
  const staging = join(importsRoot(), `${projectId}-x`);
  const cleanup = async () => {
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await mkdir(importsRoot(), { recursive: true });
    await rm(staging, { recursive: true, force: true });

    await receiveZip(request, zipPath);

    const { files } = await extractZip(zipPath, staging);
    await stripWrapperDir(staging);
    const extracted = await readdir(staging);
    if (!files || !extracted.length) {
      await cleanup();
      return Response.json(
        { error: 'The zip contains no files.' },
        { status: 422, headers }
      );
    }

    // The gate: refuse Next.js, SSR frameworks and unknown stacks BEFORE the
    // workspace exists (the hub then drops its reserved, still-hidden row).
    // Sites always live at the root.
    const check = checkFramework(staging);
    if (!check.ok) {
      await cleanup();
      return Response.json(
        { error: check.message, code: 'unsupported_framework', reason: check.reason },
        { status: 422, headers }
      );
    }

    // Local-only git repo: branch `main` regardless of git version defaults,
    // committer = bot identity, author = the uploading hub user (same
    // convention as commitAndPush).
    const identity = [
      '-c',
      `user.name=${config.gitAuthorName}`,
      '-c',
      `user.email=${config.gitAuthorEmail}`,
    ];
    const author = authorFromHeaders(request);
    const authorFlag = author
      ? [`--author=${author.name} <${author.email}>`]
      : [];
    await git(staging, ['init']);
    await git(staging, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(staging, ['add', '-A']);
    await git(staging, [
      ...identity,
      'commit',
      '-m',
      `Import ${name}`,
      ...authorFlag,
    ]);

    // Same volume — atomic publish of the workspace dir.
    await rename(staging, dir);
    await rm(zipPath, { force: true }).catch(() => undefined);

    return Response.json(
      { projectId, files, framework: check.framework },
      { status: 201, headers }
    );
  } catch (error) {
    await cleanup();
    if (error instanceof ZipError) {
      return Response.json(
        { error: error.message },
        { status: error.status, headers }
      );
    }
    console.error('[imports] failed', error);
    return Response.json(
      { error: 'Import failed. Please try again.' },
      { status: 500, headers }
    );
  }
};
