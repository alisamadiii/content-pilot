import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db';
import { job } from '@/db/schema';
import { formatClaudeLogs } from '@/lib/format-logs';
import { AutoRefresh } from '../../auto-refresh';

export const dynamic = 'force-dynamic';

const formatDate = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) : '—';

type PromptSegment = { text: string; value?: boolean };

// The exact input sent to Claude, stored as { text, value? } segments. `value`
// slices are DB-sourced (the request + element context) → full opacity; the rest
// is fixed template (the guardrail skill, labels) → dimmed.
const parsePromptSent = (raw: string | null): PromptSegment[] | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as PromptSegment[];
  } catch {
    // fall through
  }
  return null;
};

const JobDetailPage = async ({
  params,
}: {
  params: Promise<{ id: string }>;
}) => {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) {
    notFound();
  }

  const [row] = await db.select().from(job).where(eq(job.id, numericId)).limit(1);
  if (!row) {
    notFound();
  }

  const isActive = row.status === 'queued' || row.status === 'running';
  const isBatchedChild = row.batchId != null && row.batchId !== row.id;
  const promptSegments = parsePromptSent(row.promptSent);

  return (
    <>
      {isActive && <AutoRefresh seconds={5} />}
      <p>
        <Link href="/jobs">← jobs</Link>
      </p>
      <h1>
        job #{row.id}{' '}
        <span className={`status status-${row.status}`}>{row.status}</span>
      </h1>
      <p className="subtitle">
        {row.owner}/{row.repo} @ {row.branch}
        {row.requestedBy ? ` — requested by ${row.requestedBy}` : ''}
      </p>

      <div className="card">
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          prompt
        </div>
        {row.prompt}
      </div>

      {!isBatchedChild && promptSegments && (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            sent to Claude — dimmed text is the fixed template; full-opacity text
            is what we pulled from the request
          </div>
          <pre className="logs" style={{ whiteSpace: 'pre-wrap' }}>
            {promptSegments.map((seg, i) => (
              <span key={i} style={seg.value ? undefined : { opacity: 0.5 }}>
                {seg.text}
              </span>
            ))}
          </pre>
        </div>
      )}

      {row.resultSummary && (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            result
          </div>
          {row.resultSummary}
          {row.commitSha && (
            <div style={{ marginTop: 8 }}>
              <a
                href={`https://github.com/${row.owner}/${row.repo}/commit/${row.commitSha}`}
                target="_blank"
                rel="noreferrer"
              >
                {row.commitSha.slice(0, 7)} on GitHub ↗
              </a>
            </div>
          )}
        </div>
      )}

      {row.error && (
        <div className="card">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            error
          </div>
          <span className="error-text">{row.error}</span>
        </div>
      )}

      <div className="card muted" style={{ fontSize: 12 }}>
        created {formatDate(row.createdAt)} · started {formatDate(row.startedAt)}{' '}
        · finished {formatDate(row.finishedAt)}
        {row.model && <> · model {row.model}</>}
        {row.inputTokens != null && (
          <>
            {' '}· tokens {row.inputTokens.toLocaleString()} in /{' '}
            {(row.outputTokens ?? 0).toLocaleString()} out
            {row.costUsd != null && <> · ${row.costUsd.toFixed(4)}</>}
          </>
        )}
      </div>

      <h1 style={{ fontSize: 15 }}>
        claude session {row.status === 'running' && (
          <span className="status status-running">live</span>
        )}
      </h1>
      {row.batchId != null && row.batchId !== row.id ? (
        <div className="card muted">
          This request was solved together with other requests in one session —
          see the full logs on{' '}
          <Link href={`/jobs/${row.batchId}`}>job #{row.batchId}</Link>.
        </div>
      ) : (
        <pre className="logs">
          {row.logs ? formatClaudeLogs(row.logs) : 'no output yet'}
        </pre>
      )}
    </>
  );
};

export default JobDetailPage;
