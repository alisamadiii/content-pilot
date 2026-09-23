import { and, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import { job, JOB_STATUS_VALUES, repo, type JobStatus } from '@/db/schema';
import { AutoRefresh } from '../auto-refresh';

export const dynamic = 'force-dynamic';

const formatDate = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) : '—';

type Filters = {
  repo?: string;
  status?: string;
  q?: string;
  by?: string;
  from?: string;
  to?: string;
};

const JobsPage = async ({
  searchParams,
}: {
  searchParams: Promise<Filters>;
}) => {
  const filters = await searchParams;

  const conditions = [];
  if (filters.repo) {
    const repoId = Number(filters.repo);
    if (Number.isInteger(repoId) && repoId > 0) {
      conditions.push(eq(job.repoId, repoId));
    } else {
      conditions.push(
        or(
          ilike(job.repo, `%${filters.repo}%`),
          ilike(sql`${job.owner} || '/' || ${job.repo}`, `%${filters.repo}%`)
        )
      );
    }
  }
  if (
    filters.status &&
    (JOB_STATUS_VALUES as readonly string[]).includes(filters.status)
  ) {
    conditions.push(eq(job.status, filters.status as JobStatus));
  }
  if (filters.q) {
    conditions.push(
      or(
        ilike(job.prompt, `%${filters.q}%`),
        ilike(job.error, `%${filters.q}%`),
        ilike(job.resultSummary, `%${filters.q}%`)
      )
    );
  }
  if (filters.by) {
    conditions.push(ilike(job.requestedBy, `%${filters.by}%`));
  }
  if (filters.from && !Number.isNaN(Date.parse(filters.from))) {
    conditions.push(gte(job.createdAt, new Date(filters.from)));
  }
  if (filters.to && !Number.isNaN(Date.parse(filters.to))) {
    conditions.push(lte(job.createdAt, new Date(`${filters.to}T23:59:59`)));
  }

  const hasFilters = conditions.length > 0;

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
    .where(hasFilters ? and(...conditions) : undefined)
    .orderBy(desc(job.createdAt))
    .limit(100);

  const repos = await db
    .select({ repoId: repo.repoId, owner: repo.owner, repo: repo.repo })
    .from(repo)
    .orderBy(repo.owner, repo.repo);

  const running = await db
    .select({
      id: job.id,
      owner: job.owner,
      repo: job.repo,
      prompt: job.prompt,
      batchId: job.batchId,
      startedAt: job.startedAt,
    })
    .from(job)
    .where(eq(job.status, 'running'));

  // One Claude session per batch — group running rows by their batch lead.
  const sessions = new Map<
    number,
    { lead: (typeof running)[number]; count: number }
  >();
  for (const row of running) {
    const key = row.batchId ?? row.id;
    const entry = sessions.get(key);
    if (!entry) {
      sessions.set(key, { lead: row, count: 1 });
    } else {
      entry.count += 1;
      if (row.id === key) {
        entry.lead = row;
      }
    }
  }

  return (
    <>
      <AutoRefresh seconds={10} />
      <h1>jobs</h1>
      <p className="subtitle">
        {hasFilters
          ? `${rows.length} matching request${rows.length === 1 ? '' : 's'}`
          : 'last 100 edit requests, newest first'}
      </p>

      <form className="card filter-bar" method="GET" action="/jobs">
        <select name="repo" defaultValue={filters.repo ?? ''}>
          <option value="">all repos</option>
          {repos.map((entry) => (
            <option key={entry.repoId} value={String(entry.repoId)}>
              {entry.owner}/{entry.repo}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={filters.status ?? ''}>
          <option value="">any status</option>
          {JOB_STATUS_VALUES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="q"
          placeholder="search prompt / result / error"
          defaultValue={filters.q ?? ''}
          style={{ maxWidth: 240 }}
        />
        <input
          type="text"
          name="by"
          placeholder="requested by"
          defaultValue={filters.by ?? ''}
          style={{ maxWidth: 140 }}
        />
        <input type="date" name="from" defaultValue={filters.from ?? ''} />
        <input type="date" name="to" defaultValue={filters.to ?? ''} />
        <button className="primary" type="submit">
          filter
        </button>
        {hasFilters && <Link href="/jobs">clear</Link>}
      </form>

      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: sessions.size ? 8 : 0 }}>
          claude sessions:{' '}
          <span className={sessions.size ? 'status status-running' : 'muted'}>
            {sessions.size} running
          </span>
        </div>
        {[...sessions.entries()].map(([key, { lead, count }]) => {
          const elapsed = lead.startedAt
            ? Math.round((Date.now() - lead.startedAt.getTime()) / 1000)
            : 0;
          return (
            <div key={key} className="row" style={{ fontSize: 13 }}>
              <span className="status status-running">●</span>
              <Link href={`/jobs/${key}`}>#{key}</Link>
              <span>
                {lead.owner}/{lead.repo}
              </span>
              {count > 1 ? (
                <span className="muted">
                  solving {count} requests in one session
                </span>
              ) : (
                <span className="muted prompt-cell" style={{ maxWidth: 300 }}>
                  {lead.prompt}
                </span>
              )}
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
                      solved in one session with{' '}
                      <Link href={`/jobs/${row.batchId}`}>#{row.batchId}</Link> —
                      logs &amp; tokens there
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
                  ) : row.batchId != null && row.batchId !== row.id ? (
                    <Link href={`/jobs/${row.batchId}`}>see #{row.batchId}</Link>
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
