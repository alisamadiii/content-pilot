import Link from 'next/link';
import { desc, like } from 'drizzle-orm';
import { db } from '@/db';
import {
  appSetting,
  PREVIEW_SESSION_LIVE_STATUSES,
  previewSession,
} from '@/db/schema';
import { previewBaseHost } from '@/lib/domain-rules';
import { repoColor } from '@/lib/repo-color';
import { listWorkspaces } from '@/lib/repos';
import {
  diskOverview,
  dirSizeBytes,
  formatBytes,
  memoryOverview,
  processSnapshot,
  treeRss,
} from '@/lib/resource-usage';
import { config } from '@/worker/config';
import { repoDir } from '@/worker/git';
import { join } from 'path';
import { UrlAction, type UrlTarget } from './url-actions';
import { previewConfig, previewUrlFor } from '@/preview/config';
import { hasLiveSite, liveServeRoot, liveUrlFor } from '@/preview/live-serve';

export const dynamic = 'force-dynamic';

type UrlRow = {
  kind: string;
  url: string;
  note?: string;
  status?: string;
  /** Display values for the disk / ram columns. */
  disk: string;
  ram: string;
  /** What the row's remove button acts on. */
  target: UrlTarget;
};

const SORTS = [
  { value: 'urls', label: 'most urls' },
  { value: 'disk', label: 'most disk' },
  { value: 'name', label: 'name' },
  { value: 'recent', label: 'recent activity' },
  { value: 'id', label: 'repo id' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

// Live site = green dot, editing preview = purple dot; domains keep their label.
const KIND_DOT: Record<string, string> = {
  'live site': 'var(--green)',
  'editing preview': 'var(--purple)',
};

/**
 * Every URL the pilot currently answers, grouped per project: the live site
 * (`site-<repoId>`), its free subdomain and custom domains, and any active
 * editing preview session.
 */
const UrlsPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) => {
  const requested = (await searchParams).sort;
  const sort: Sort = SORTS.some((s) => s.value === requested)
    ? (requested as Sort)
    : 'urls';

  const [workspaces, domainRows, sessions] = await Promise.all([
    listWorkspaces(),
    db.select().from(appSetting).where(like(appSetting.key, 'domain:%')),
    db
      .select({
        id: previewSession.id,
        repoId: previewSession.repoId,
        owner: previewSession.owner,
        repo: previewSession.repo,
        status: previewSession.status,
        branch: previewSession.branch,
        pid: previewSession.pid,
        createdAt: previewSession.createdAt,
      })
      .from(previewSession)
      .orderBy(desc(previewSession.createdAt)),
  ]);

  // Display names: the git remote for GitHub clones; for uploads (no remote)
  // the hub's name, carried on the newest session row.
  const names = new Map<number, string>();
  // Newest session per project = its last editing activity (sessions are
  // ordered newest first).
  const lastActivity = new Map<number, number>();
  for (const s of sessions) {
    if (!names.has(s.repoId)) names.set(s.repoId, `${s.owner}/${s.repo}`);
    if (!lastActivity.has(s.repoId)) {
      lastActivity.set(s.repoId, s.createdAt.getTime());
    }
  }
  for (const w of workspaces) {
    if (w.owner !== 'upload') names.set(w.repoId, `${w.owner}/${w.repo}`);
  }

  const base = previewBaseHost(previewConfig.urlBase);
  const domains = new Map<number, UrlRow[]>();
  for (const r of domainRows) {
    const repoId = Number(r.value);
    if (!Number.isSafeInteger(repoId)) continue;
    const host = r.key.slice('domain:'.length);
    const free = base && host.endsWith(`.${base}`);
    // Domains serve the live site's files: no disk or memory of their own.
    const row: UrlRow = {
      kind: free ? 'free subdomain' : 'custom domain',
      url: free
        ? previewConfig.urlBase.replace(
            '{id}',
            host.slice(0, -(base.length + 1)),
          )
        : `https://${host}`,
      disk: 'same as live',
      ram: 'shared',
      target: { kind: free ? 'free subdomain' : 'custom domain', host },
    };
    domains.set(repoId, [...(domains.get(repoId) ?? []), row]);
  }

  const procs = await processSnapshot();
  const liveStatuses = new Set<string>(PREVIEW_SESSION_LIVE_STATUSES);
  const previews = new Map<number, UrlRow[]>();
  const previewRam = new Map<number, number>();
  for (const s of sessions) {
    if (!liveStatuses.has(s.status)) continue;
    // RAM of the dev server and everything it spawned (astro/vite workers).
    const ram = s.pid ? treeRss(procs, s.pid) : null;
    if (ram) previewRam.set(s.repoId, (previewRam.get(s.repoId) ?? 0) + ram);
    previews.set(s.repoId, [
      ...(previews.get(s.repoId) ?? []),
      {
        kind: 'editing preview',
        url: previewUrlFor(s.id),
        note: s.branch,
        status: s.status,
        disk: 'workspace',
        ram: formatBytes(ram),
        target: { kind: 'editing preview', sessionId: s.id },
      },
    ]);
  }

  const repoIds = [
    ...new Set([
      ...workspaces.map((w) => w.repoId),
      ...domains.keys(),
      ...previews.keys(),
    ]),
  ].sort((a, b) => a - b);

  const [disk, projects] = await Promise.all([
    diskOverview(config.workspaceDir),
    Promise.all(
      repoIds.map(async (repoId) => {
        const live = hasLiveSite(repoId);
        const [workspaceBytes, nodeModulesBytes, liveBytes] = await Promise.all(
          [
            dirSizeBytes(repoDir(repoId)),
            dirSizeBytes(join(repoDir(repoId), 'node_modules')),
            live ? dirSizeBytes(liveServeRoot(repoId)) : Promise.resolve(0),
          ],
        );
        const rows: UrlRow[] = [];
        if (live) {
          // Static files served by the shared proxy: no process of its own.
          rows.push({
            kind: 'live site',
            url: liveUrlFor(repoId),
            disk: formatBytes(liveBytes),
            ram: 'shared',
            target: { kind: 'live site', repoId },
          });
        }
        rows.push(
          ...(domains.get(repoId) ?? []),
          ...(previews.get(repoId) ?? []),
        );
        return {
          repoId,
          name: names.get(repoId) ?? String(repoId),
          rows,
          workspaceBytes,
          nodeModulesBytes,
          totalBytes: workspaceBytes + liveBytes,
          ramBytes: previewRam.get(repoId) ?? 0,
        };
      }),
    ),
  ]);
  const memory = memoryOverview();
  const totalProjectBytes = projects.reduce((sum, p) => sum + p.totalBytes, 0);
  const totalPreviewRam = projects.reduce((sum, p) => sum + p.ramBytes, 0);

  projects.sort((a, b) => {
    if (sort === 'id') return a.repoId - b.repoId;
    if (sort === 'recent') {
      return (
        (lastActivity.get(b.repoId) ?? 0) - (lastActivity.get(a.repoId) ?? 0) ||
        a.name.localeCompare(b.name)
      );
    }
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'disk') {
      return b.totalBytes - a.totalBytes || a.name.localeCompare(b.name);
    }
    return b.rows.length - a.rows.length || a.name.localeCompare(b.name);
  });

  return (
    <>
      <h1>urls</h1>
      <p className="subtitle">
        every live site, domain and active editing preview, per project
      </p>
      <p className="muted" style={{ margin: '-16px 0 16px', fontSize: 12 }}>
        <span className="kind-dot" style={{ background: 'var(--green)' }} />{' '}
        live site{'   '}
        <span
          className="kind-dot"
          style={{ background: 'var(--purple)', marginLeft: 12 }}
        />{' '}
        editing preview
      </p>

      <div className="card filter-bar" style={{ gap: 24 }}>
        <span>
          <span className="muted">projects disk</span>{' '}
          <strong>{formatBytes(totalProjectBytes)}</strong>
        </span>
        {disk && (
          <span>
            <span className="muted">volume free</span>{' '}
            <strong>{formatBytes(disk.freeBytes)}</strong>
            <span className="muted"> of {formatBytes(disk.totalBytes)}</span>
          </span>
        )}
        <span>
          <span className="muted">{memory.scope} ram</span>{' '}
          <strong>{formatBytes(memory.usedBytes)}</strong>
          <span className="muted"> of {formatBytes(memory.totalBytes)}</span>
        </span>
        <span>
          <span className="muted">previews ram</span>{' '}
          <strong>{formatBytes(totalPreviewRam)}</strong>
        </span>
      </div>

      <div className="card filter-bar">
        <span className="muted">sort by</span>
        {SORTS.map((option) =>
          option.value === sort ? (
            <strong key={option.value}>{option.label}</strong>
          ) : (
            <Link key={option.value} href={`/urls?sort=${option.value}`}>
              {option.label}
            </Link>
          ),
        )}
      </div>

      {projects.length === 0 ? (
        <div className="card muted">No projects yet.</div>
      ) : (
        <table className="urls-table">
          <thead>
            <tr>
              <th>project</th>
              <th>type</th>
              <th>url</th>
              <th>status</th>
              <th>disk</th>
              <th>ram</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const [owner = '', repo = ''] = project.name.split('/');
              const rows = project.rows.length ? project.rows : [null];
              // Project cell spans all of its URL rows.
              const projectCell = (
                <td rowSpan={rows.length}>
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
                  {project.name}
                  <div className="muted" style={{ fontSize: 12 }}>
                    {project.repoId}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    disk {formatBytes(project.totalBytes)}
                    {project.nodeModulesBytes > 0 &&
                      ` (node_modules ${formatBytes(project.nodeModulesBytes)})`}
                  </div>
                </td>
              );
              return rows.map((row, index) =>
                row ? (
                  <tr key={`${project.repoId}-${row.url}`}>
                    {index === 0 && projectCell}
                    <td className="muted">
                      {KIND_DOT[row.kind] ? (
                        <span
                          title={row.kind}
                          aria-label={row.kind}
                          className="kind-dot"
                          style={{ background: KIND_DOT[row.kind] }}
                        />
                      ) : (
                        row.kind
                      )}
                    </td>
                    <td style={{ wordBreak: 'break-all' }}>
                      <a href={row.url} target="_blank" rel="noreferrer">
                        {row.url}
                      </a>
                    </td>
                    <td>
                      {row.status && (
                        <span className={`status status-${row.status}`}>
                          {row.status}
                        </span>
                      )}{' '}
                      {row.note && <span className="muted">{row.note}</span>}
                    </td>
                    <td className="muted">{row.disk}</td>
                    <td className="muted">{row.ram}</td>
                    <td style={{ textAlign: 'right' }}>
                      <UrlAction target={row.target} url={row.url} />
                    </td>
                  </tr>
                ) : (
                  <tr key={`${project.repoId}-empty`}>
                    {projectCell}
                    <td className="muted" colSpan={6}>
                      Nothing online. Not published yet and no active preview.
                    </td>
                  </tr>
                ),
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
};

export default UrlsPage;
