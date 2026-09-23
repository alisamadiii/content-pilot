import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { job } from '@/db/schema';
import { AutoRefresh } from '../auto-refresh';

export const dynamic = 'force-dynamic';

const formatDate = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) : '—';

const JobsPage = async () => {
  const rows = await db
    .select({
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      prompt: job.prompt,
      requestedBy: job.requestedBy,
      status: job.status,
      error: job.error,
      batchId: job.batchId,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      model: job.model,
      inputTokens: job.inputTokens,
      outputTokens: job.outputTokens,
      costUsd: job.costUsd,
    })
    .from(job)
    .orderBy(desc(job.createdAt))
    .limit(100);

  const running = await db
    .select({
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      prompt: job.prompt,
      startedAt: job.startedAt,
    })
    .from(job)
    .where(eq(job.status, 'running'));

  return (
    <>
      <AutoRefresh seconds={10} />
      <h1>jobs</h1>
      <p className="subtitle">last 100 edit requests, newest first</p>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: running.length ? 8 : 0 }}>
          claude sessions:{' '}
          <span className={running.length ? 'status status-running' : 'muted'}>
            {running.length} running
          </span>
        </div>
        {running.map((session) => {
          const elapsed = session.startedAt
            ? Math.round((Date.now() - session.startedAt.getTime()) / 1000)
            : 0;
          return (
            <div key={session.id} className="row" style={{ fontSize: 13 }}>
              <span className="status status-running">●</span>
              <Link href={`/jobs/${session.id}`}>#{session.id}</Link>
              <span>
                {session.owner}/{session.repo}
              </span>
              <span className="muted prompt-cell" style={{ maxWidth: 300 }}>
                {session.prompt}
              </span>
              <span className="muted">{elapsed}s</span>
            </div>
          );
        })}
      </div>
      {rows.length === 0 ? (
        <div className="card muted">
          No jobs yet. Seed one locally with <code>pnpm seed</code> or POST to{' '}
          <code>/api/v1/jobs</code>.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>repo</th>
              <th>prompt</th>
              <th>by</th>
              <th>status</th>
              <th>tokens</th>
              <th>created</th>
              <th>finished</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/jobs/${row.id}`}>#{row.id}</Link>
                </td>
                <td>
                  {row.owner}/{row.repo}
                </td>
                <td className="prompt-cell" title={row.prompt}>
                  {row.prompt}
                </td>
                <td className="muted">{row.requestedBy || '—'}</td>
                <td>
                  <span className={`status status-${row.status}`}>
                    {row.status}
                  </span>
                  {row.error && (
                    <div className="muted" style={{ fontSize: 12, maxWidth: 240 }}>
                      {row.error.slice(0, 120)}
                    </div>
                  )}
                  {row.batchId != null && row.batchId !== row.id && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      batch #{row.batchId}
                    </div>
                  )}
                </td>
                <td className="muted">
                  {row.inputTokens != null ? (
                    <>
                      {(row.inputTokens + (row.outputTokens ?? 0)).toLocaleString()}
                      {row.costUsd != null && (
                        <div style={{ fontSize: 12 }}>
                          ${row.costUsd.toFixed(4)}
                        </div>
                      )}
                      {row.model && (
                        <div style={{ fontSize: 11 }}>{row.model}</div>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="muted">{formatDate(row.createdAt)}</td>
                <td className="muted">{formatDate(row.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
};

export default JobsPage;
