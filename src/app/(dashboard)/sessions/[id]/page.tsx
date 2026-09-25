import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db';
import {
  previewMessage,
  previewSession,
  PREVIEW_SESSION_LIVE_STATUSES,
} from '@/db/schema';
import { previewUrlFor } from '@/preview/config';
import { AutoRefresh } from '../../auto-refresh';
import { SessionActions } from '../session-actions';

export const dynamic = 'force-dynamic';

const formatDate = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) : '—';

const LIVE = [...PREVIEW_SESSION_LIVE_STATUSES];

const SessionDetailPage = async ({
  params,
}: {
  params: Promise<{ id: string }>;
}) => {
  const { id } = await params;

  const [row] = await db
    .select()
    .from(previewSession)
    .where(eq(previewSession.id, id))
    .limit(1);
  if (!row) {
    notFound();
  }

  const isLive = LIVE.includes(row.status as (typeof LIVE)[number]);

  const messages = await db
    .select()
    .from(previewMessage)
    .where(eq(previewMessage.sessionId, id))
    .orderBy(asc(previewMessage.id));

  return (
    <>
      {isLive && <AutoRefresh seconds={5} />}
      <p>
        <Link href="/sessions">← sessions</Link>
      </p>
      <h1>
        session {row.id}{' '}
        <span className={`status status-${row.status}`}>{row.status}</span>
      </h1>
      <p className="subtitle">
        {row.owner}/{row.repo} @ {row.branch}
        {row.requestedBy ? ` — requested by ${row.requestedBy}` : ''}
      </p>

      <div className="card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          {(row.status === 'ready' || row.status === 'restarting') && (
            <a href={previewUrlFor(row.id)} target="_blank" rel="noreferrer">
              open preview ↗
            </a>
          )}
          {isLive && <SessionActions id={row.id} status={row.status} />}
          <span className="muted" style={{ fontSize: 12 }}>
            port {row.port ?? '—'} · pid {row.pid ?? '—'}
            {row.claudeSessionId && (
              <> · claude {row.claudeSessionId.slice(0, 8)}…</>
            )}
          </span>
        </div>
      </div>

      {row.error && (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            error
          </div>
          <span className="error-text">{row.error}</span>
        </div>
      )}

      <div className="card muted" style={{ fontSize: 12 }}>
        created {formatDate(row.createdAt)} · last activity{' '}
        {formatDate(row.lastActivityAt)} · closed {formatDate(row.closedAt)}
      </div>

      <h1 style={{ fontSize: 15 }}>
        chat{' '}
        {isLive && <span className="status status-running">live</span>}
      </h1>
      {messages.length === 0 ? (
        <div className="card muted">No messages yet.</div>
      ) : (
        messages.map((message) => {
          const mine = message.role === 'user';
          return (
            <div
              key={message.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: mine ? 'flex-end' : 'flex-start',
                marginBottom: 14,
              }}
            >
              <div
                className="muted"
                style={{
                  fontSize: 12,
                  marginBottom: 4,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  justifyContent: mine ? 'flex-end' : 'flex-start',
                  maxWidth: '72%',
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    color: mine ? 'var(--accent)' : 'var(--fg)',
                  }}
                >
                  {mine ? 'client' : 'AI'}
                </span>
                <span className={`status status-${message.status}`}>
                  {message.status}
                </span>
                {message.commitSha && (
                  <a
                    href={`https://github.com/${row.owner}/${row.repo}/commit/${message.commitSha}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {message.commitSha.slice(0, 7)} ↗
                  </a>
                )}
                <span>{formatDate(message.createdAt)}</span>
                {message.inputTokens != null && (
                  <span>
                    {message.inputTokens.toLocaleString()} in /{' '}
                    {(message.outputTokens ?? 0).toLocaleString()} out
                    {message.costUsd != null && (
                      <> · ${message.costUsd.toFixed(4)}</>
                    )}
                    {message.model && <> · {message.model}</>}
                  </span>
                )}
              </div>
              <div
                style={{
                  maxWidth: '72%',
                  whiteSpace: 'pre-wrap',
                  padding: '10px 14px',
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: mine ? 'var(--accent)' : 'var(--bg-alt)',
                  color: mine ? '#0d1117' : 'var(--fg)',
                  borderBottomRightRadius: mine ? 2 : 12,
                  borderBottomLeftRadius: mine ? 12 : 2,
                }}
              >
                {message.content}
                {message.error && (
                  <div
                    className="error-text"
                    style={{ fontSize: 12, marginTop: 6 }}
                  >
                    {message.error}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </>
  );
};

export default SessionDetailPage;
