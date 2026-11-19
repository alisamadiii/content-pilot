import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { client, db } from '@/db';
import { previewSession } from '@/db/schema';
import { verifyApiKey } from '@/lib/api-key';
import { extractCredentials } from '@/lib/request-credentials';
import { getProjectEnv, setProjectEnv } from '@/lib/settings';
import { ENV_KEY_PATTERN, readEnvExample } from '@/preview/env-example';
import { repoDir } from '@/worker/git';

export const runtime = 'nodejs';

/**
 * Server-to-server (x-api-key only, never an edit token — values are secrets):
 * the project env variables for the live preview. The variable list is the
 * session clone's `.env.example`; values are stored encrypted per project
 * (shared by all its sessions) and passed to the dev server's process env.
 * Values are never logged.
 */

const MAX_KEYS = 100;
const MAX_VALUE_LENGTH = 8192;

const body = z.object({
  values: z
    .record(
      z.string().regex(ENV_KEY_PATTERN, {
        error: 'Variable names must be uppercase letters, digits and underscores.',
      }),
      z
        .string()
        .max(MAX_VALUE_LENGTH, {
          error: `Values can be at most ${MAX_VALUE_LENGTH} characters.`,
        })
        .refine((value) => !/[\r\n]/.test(value), {
          error: 'Values cannot contain line breaks.',
        })
    )
    .refine((values) => Object.keys(values).length <= MAX_KEYS, {
      error: `At most ${MAX_KEYS} variables can be saved at once.`,
    }),
});

/** One plain sentence for the hub, naming the offending variable. */
const issueMessage = (issue: z.core.$ZodIssue | undefined) => {
  if (!issue || issue.code === 'invalid_type') return 'Invalid request';
  const key = issue.path.length >= 2 ? String(issue.path[1]) : null;
  const message =
    issue.code === 'invalid_key'
      ? (issue.issues[0]?.message ?? 'Invalid variable name.')
      : issue.message;
  return key ? `${key}: ${message}` : message;
};

const loadSession = async (request: Request, id: string) => {
  const { apiKeyCandidate } = extractCredentials(request);
  if (!(await verifyApiKey(apiKeyCandidate))) {
    return { response: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const [row] = await db
    .select({ id: previewSession.id, projectId: previewSession.projectId })
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) {
    return { response: Response.json({ error: 'Session not found' }, { status: 404 }) };
  }
  if (!row.projectId) {
    return {
      response: Response.json(
        { error: 'This session has no project id. Start a new session.' },
        { status: 400 }
      ),
    };
  }
  return { projectId: row.projectId, dir: repoDir(row.projectId) };
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const result = await loadSession(request, id);
  if ('response' in result) return result.response;
  const entries = readEnvExample(result.dir);
  const stored = entries.length ? await getProjectEnv(result.projectId) : {};
  return Response.json({
    variables: entries.map((entry) => ({ ...entry, value: stored[entry.key] ?? '' })),
  });
};

export const PUT = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  const result = await loadSession(request, id);
  if ('response' in result) return result.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: issueMessage(parsed.error.issues[0]) }, { status: 400 });
  }
  const known = new Set(readEnvExample(result.dir).map((entry) => entry.key));
  const unknown = Object.keys(parsed.data.values).filter((key) => !known.has(key));
  if (unknown.length) {
    return Response.json(
      { error: `Not listed in the project's .env.example: ${unknown.join(', ')}` },
      { status: 400 }
    );
  }
  try {
    await setProjectEnv(result.projectId, parsed.data.values);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`[env] project ${result.projectId}: saving env values failed — ${message}`);
    return Response.json(
      {
        error: message.startsWith('ENV_ENCRYPTION_KEY')
          ? message
          : 'Saving the environment variables failed.',
      },
      { status: 500 }
    );
  }
  // Respawn the dev server so the new values apply; changes and chat stay.
  await db
    .update(previewSession)
    .set({ devRestartRequestedAt: new Date(), updatedAt: new Date() })
    .where(eq(previewSession.id, id));
  try {
    await client.notify('cp_preview', '');
  } catch {
    // supervisor also polls
  }
  return Response.json({ ok: true });
};
