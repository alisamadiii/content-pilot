import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import Link from 'next/link';
import { db } from '@/db';
import {
  previewMessage,
  previewSession,
  PREVIEW_SESSION_LIVE_STATUSES,
  PREVIEW_SESSION_STATUS_VALUES,
  type PreviewSessionStatus,
} from '@/db/schema';
import { previewUrlFor } from '@/preview/config';
import { repoColor } from '@/lib/repo-color';
import { AutoRefresh } from '../auto-refresh';
import { SessionActions } from './session-actions';

export const dynamic = 'force-dynamic';

const formatDate = (date: Date | null) =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) : '—';

const RepoTag = ({ owner, repo }: { owner: string; repo: string }) => (
  <>
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: repoColor(owner, repo),
        marginRight: 6,
        verticalAlign: 'middle',
      }}
    />
    {owner}/{repo}
  </>
);

type Filters = {
  status?: string;
  repo?: string;
  page?: string;
};

const PAGE_SIZE = 25;

const LIVE = [...PREVIEW_SESSION_LIVE_STATUSES];

const SessionsPage = async ({
  searchParams,
}: {
  searchParams: Promise<Filters>;
}) => {
  const filters = await searchParams;
  // Default to live sessions — the ones holding ports and dev-server slots.
  const status = filters.status ?? 'live';

  const conditions = [];
  if (status === 'live') {
    conditions.push(inArray(previewSession.status, LIVE));
  } else if (
    (PREVIEW_SESSION_STATUS_VALUES as readonly string[]).includes(status)
  ) {
    conditions.push(eq(previewSession.status, status as PreviewSessionStatus));
  }
  if (filters.repo) {
    conditions.push(
      or(
        ilike(previewSession.repo, `%${filters.repo}%`),
        ilike(
          sql`${previewSession.owner} || '/' || ${previewSession.repo}`,
          `%${filters.repo}%`
        )
      )
    );
  }

  const hasFilters = conditions.length > 0;
  const page = Math.max(1, Number(filters.page) || 1);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(previewSession)
    .where(hasFilters ? and(...conditions) : undefined);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rows = await db
    .select()
    .from(previewSession)
    .where(hasFilters ? and(...conditions) : undefined)
    .orderBy(desc(previewSession.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const messageCounts = new Map<string, number>();
  if (rows.length) {
    const counts = await db
      .select({
        sessionId: previewMessage.sessionId,
        count: sql<number>`count(*)::int`,
      })
      .from(previewMessage)
      .where(
        inArray(
          previewMessage.sessionId,
          rows.map((row) => row.id)
        )
      )
      .groupBy(previewMessage.sessionId);
    for (const entry of counts) {
      messageCounts.set(entry.sessionId, entry.count);
    }
  }

  const liveCount = rows.filter((row) =>
    LIVE.includes(row.status as (typeof LIVE)[number])
  ).length;

  return (
    <>
      <AutoRefresh seconds={10} />
      <h1>sessions</h1>
      <p className="subtitle">
        {total} session{total === 1 ? '' : 's'}
        {hasFilters ? ' matching' : ''} · page {page} of {totalPages}
        {status === 'live' && ` · ${liveCount} live`}
      </p>

      <form className="card filter-bar" method="GET" action="/sessions">
        <select name="status" defaultValue={status}>
          <option value="live">live</option>
          <option value="all">all statuses</option>
          {PREVIEW_SESSION_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="repo"
          placeholder="repo"
          defaultValue={filters.repo ?? ''}
          style={{ maxWidth: 200 }}
        />
        <button className="primary" type="submit">
          filter
        </button>
        {(filters.status || filters.repo) && <Link href="/sessions">clear</Link>}
      </form>

      {rows.length === 0 ? (
        <div className="card muted">
          {status === 'live'
            ? 'No live sessions. Clients start them from the hub canvas editor.'
            : 'No sessions match.'}
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>session</th>
              <th>repo</th>
              <th>branch</th>
              <th>status</th>
              <th>port</th>
              <th>by</th>
              <th>msgs</th>
              <th>last activity</th>
              <th>created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isLive = LIVE.includes(
                row.status as (typeof LIVE)[number]
              );
              return (
                <tr key={row.id}>
                  <td>
                    <Link href={`/sessions/${row.id}`}>{row.id}</Link>
                  </td>
                  <td>
                    <RepoTag owner={row.owner} repo={row.repo} />
                  </td>
                  <td className="muted">{row.branch}</td>
                  <td>
                    <span className={`status status-${row.status}`}>
                      {row.status}
                    </span>
                    {row.error && (
                      <div
                        className="muted"
                        style={{ fontSize: 12, maxWidth: 240 }}
                      >
                        {row.error.slice(0, 120)}
                      </div>
                    )}
                  </td>
                  <td className="muted">{row.port ?? '—'}</td>
                  <td className="muted">{row.requestedBy || '—'}</td>
                  <td className="muted">{messageCounts.get(row.id) ?? 0}</td>
                  <td className="muted">{formatDate(row.lastActivityAt)}</td>
                  <td className="muted">{formatDate(row.createdAt)}</td>
                  <td>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      {(row.status === 'ready' ||
                        row.status === 'restarting') && (
                        <a
                          href={previewUrlFor(row.id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          preview ↗
                        </a>
                      )}
                      {isLive && (
                        <SessionActions id={row.id} status={row.status} />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="row" style={{ marginTop: 16, justifyContent: 'center' }}>
          {page > 1 ? (
            <Link href={pageHref(filters, page - 1)}>← prev</Link>
          ) : (
            <span className="muted">← prev</span>
          )}
          <span className="muted">
            {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={pageHref(filters, page + 1)}>next →</Link>
          ) : (
            <span className="muted">next →</span>
          )}
        </div>
      )}
    </>
  );
};

const pageHref = (filters: Filters, page: number) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && key !== 'page') {
      params.set(key, value);
    }
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query ? `/sessions?${query}` : '/sessions';
};

export default SessionsPage;
