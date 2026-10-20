import { createWriteStream, existsSync } from 'fs';
import { mkdir, readdir, rename, rm } from 'fs/promises';
import { join } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { verifyApiKey } from '@/lib/api-key';
import { verifyImportToken } from '@/lib/import-token';
import { extractCredentials, sessionCorsHeaders } from '@/lib/request-credentials';
import { config, ensureWorkspace } from '@/worker/config';
import { git, repoDir } from '@/worker/git';
import { extractZip, stripWrapperDir, ZipError } from '@/worker/zip-extract';
import { detectFramework } from '@/preview/framework';
import { findAppDir } from '@/preview/session-boot';
import { refreshLiveSnapshot } from '@/preview/live-serve';

export const runtime = 'nodejs';

/**
 * Project import for uploaded (no-GitHub) projects: the hub mints a one-time
 * import token bound to a fresh synthetic repoId, the browser POSTs the zip
 * straight here (Vercel's body cap rules out proxying through the hub), and
 * the extracted tree becomes a local-only git workspace — `git init`, branch
 * `main`, one initial commit. For static sites the first live snapshot is
 * written immediately so the live URL works before the first publish.
 *
 * The body is a raw zip stream (`Content-Type: application/zip`), never
 * multipart: `request.formData()` would buffer the whole archive in memory.
 */

const MAX_ZIP_BYTES = 100 * 1024 * 1024;

const importsRoot = () => join(config.workspaceDir, '.imports');

export const OPTIONS = async (request: Request) =>
  new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });

const authenticate = async (request: Request, repoId: number) => {
  const { apiKeyCandidate, editTokenCandidate } = extractCredentials(request);
  if (await verifyApiKey(apiKeyCandidate)) return true;
  const token = verifyImportToken(editTokenCandidate);
  return token !== null && token.repoId === repoId;
};

/** One header line of commit identity, length-capped; null when absent. */
const authorFromHeaders = (request: Request) => {
  const name = (request.headers.get('x-author-name') || '').trim().slice(0, 200);
  const email = (request.headers.get('x-author-email') || '')
    .trim()
    .slice(0, 320);
  return name && email ? { name, email } : null;
};

export const POST = async (request: Request) => {
  const headers = sessionCorsHeaders(request.headers.get('origin'));
  const url = new URL(request.url);
  const repoId = Number(url.searchParams.get('repoId'));
  const name = (url.searchParams.get('name') || 'site').slice(0, 100);
  if (!Number.isSafeInteger(repoId) || repoId <= 0) {
    return Response.json({ error: 'repoId required' }, { status: 400, headers });
  }

  if (!(await authenticate(request, repoId))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const dir = repoDir(repoId);
  if (existsSync(dir)) {
    // Also what makes the import token effectively single-use.
    return Response.json(
      { error: 'This project was already imported.' },
      { status: 409, headers }
    );
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_ZIP_BYTES) {
    return Response.json(
      { error: 'Zip is larger than 100 MB.' },
      { status: 413, headers }
    );
  }
  if (!request.body) {
    return Response.json({ error: 'Empty body' }, { status: 400, headers });
  }

  ensureWorkspace();
  const zipPath = join(importsRoot(), `${repoId}.zip`);
  const staging = join(importsRoot(), `${repoId}-x`);
  const cleanup = async () => {
    await rm(zipPath, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await mkdir(importsRoot(), { recursive: true });
    await rm(staging, { recursive: true, force: true });

    // Stream the body to disk, counting real bytes — content-length can lie.
    // Counting happens in-pipeline (a bare 'data' listener would start the
    // flow before the file stream is attached and drop bytes).
    let received = 0;
    const body = Readable.fromWeb(
      request.body as import('stream/web').ReadableStream
    );
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_ZIP_BYTES) {
          callback(new ZipError('Zip is larger than 100 MB.', 413));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(body, counter, createWriteStream(zipPath));

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

    let framework: string | null = null;
    try {
      framework = detectFramework(findAppDir(dir));
    } catch {
      framework = null;
    }
    const liveUrl = await refreshLiveSnapshot(repoId);

    return Response.json(
      { repoId, files, framework, liveUrl },
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
