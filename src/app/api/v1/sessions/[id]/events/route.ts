import { and, asc, eq, gt } from 'drizzle-orm';
import { client, db } from '@/db';
import {
  PREVIEW_SESSION_LIVE_STATUSES,
  previewEvent,
  previewSession,
} from '@/db/schema';
import {
  authenticateSessionRequest,
  sessionCorsHeaders,
} from '@/lib/session-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LIVE: string[] = [...PREVIEW_SESSION_LIVE_STATUSES];

// One shared LISTEN connection for the whole Next process; SSE connections
// subscribe in-memory. The supervisor NOTIFYs with the sessionId as payload.
const subscribers = new Map<string, Set<() => void>>();
let listening: Promise<void> | null = null;

const ensureListener = () => {
  listening ??= client
    .listen('cp_preview_events', (payload) => {
      subscribers.get(payload)?.forEach((wake) => wake());
    })
    .then(() => undefined);
  return listening;
};

const subscribe = (sessionId: string, wake: () => void) => {
  let set = subscribers.get(sessionId);
  if (!set) {
    set = new Set();
    subscribers.set(sessionId, set);
  }
  set.add(wake);
  return () => {
    set!.delete(wake);
    if (!set!.size) subscribers.delete(sessionId);
  };
};

export const OPTIONS = async (request: Request) => {
  return new Response(null, {
    status: 204,
    headers: sessionCorsHeaders(request.headers.get('origin')),
  });
};

export const GET = async (
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const cors = sessionCorsHeaders(request.headers.get('origin'));
  const { id } = await params;
  const auth = await authenticateSessionRequest(request);
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }
  const [session] = await db
    .select({ repoId: previewSession.repoId, status: previewSession.status })
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!session) {
    return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
  }
  if (auth.kind === 'edit-token' && auth.payload.repoId !== session.repoId) {
    return Response.json({ error: 'Forbidden' }, { status: 403, headers: cors });
  }

  await ensureListener();

  const url = new URL(request.url);
  // EventSource reconnects send Last-Event-ID; the first connect may pass
  // ?after= for the same lossless-replay behavior.
  let lastId = Number(
    request.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0
  );
  if (!Number.isFinite(lastId)) lastId = 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let wakeLoop: (() => void) | null = null;

      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };

      const unsubscribe = subscribe(id, () => wakeLoop?.());

      const heartbeat = setInterval(() => send(': hb\n\n'), 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        wakeLoop?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener('abort', cleanup);

      const pump = async () => {
        while (!closed) {
          const rows = await db
            .select()
            .from(previewEvent)
            .where(
              and(eq(previewEvent.sessionId, id), gt(previewEvent.id, lastId))
            )
            .orderBy(asc(previewEvent.id))
            .limit(500);
          for (const row of rows) {
            lastId = row.id;
            send(
              `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({
                messageId: row.messageId,
                ...JSON.parse(row.data),
              })}\n\n`
            );
          }

          // A torn-down session prunes its events — tell the client it's over
          // instead of leaving a silent stream.
          const [current] = await db
            .select({ status: previewSession.status, error: previewSession.error })
            .from(previewSession)
            .where(eq(previewSession.id, id))
            .limit(1);
          if (!current || !LIVE.includes(current.status)) {
            send(
              `event: session-ended\ndata: ${JSON.stringify({
                status: current?.status ?? 'closed',
                error: current?.error ?? null,
              })}\n\n`
            );
            cleanup();
            return;
          }

          // Sleep until NOTIFY or the poll fallback fires.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 5_000);
            wakeLoop = () => {
              clearTimeout(timer);
              wakeLoop = null;
              resolve();
            };
          });
        }
      };

      send(': connected\n\n');
      void pump().catch(cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
