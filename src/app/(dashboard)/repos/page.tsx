import { desc, eq, sql } from 'drizzle-orm';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { db } from '@/db';
import { job, repo } from '@/db/schema';

export const dynamic = 'force-dynamic';

const ReposPage = async () => {
  const workspaceDir = resolve(process.env.WORKSPACE_DIR || './workspace');

  const rows = await db
    .select({
      repoId: repo.repoId,
      owner: repo.owner,
      repo: repo.repo,
      branch: repo.branch,
      jobCount: sql<number>`(SELECT count(*) FROM ${job} WHERE ${job.repoId} = ${repo.repoId})`,
      lastJobAt: sql<string | null>`(SELECT max(${job.createdAt}) FROM ${job} WHERE ${job.repoId} = ${repo.repoId})`,
    })
    .from(repo)
    .orderBy(desc(repo.updatedAt));

  return (
    <>
      <h1>repos</h1>
      <p className="subtitle">sites known to this instance</p>
      {rows.length === 0 ? (
        <div className="card muted">
          No repos yet — they are registered automatically with the first job.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>repo id</th>
              <th>repository</th>
              <th>branch</th>
              <th>jobs</th>
              <th>last job</th>
              <th>cloned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cloned = existsSync(
                join(workspaceDir, String(row.repoId), '.git')
              );
              return (
                <tr key={row.repoId}>
                  <td className="muted">{row.repoId}</td>
                  <td>
                    <a
                      href={`https://github.com/${row.owner}/${row.repo}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.owner}/{row.repo}
                    </a>
                  </td>
                  <td className="muted">{row.branch}</td>
                  <td>{row.jobCount}</td>
                  <td className="muted">
                    {row.lastJobAt
                      ? String(row.lastJobAt).replace('T', ' ').slice(0, 19)
                      : '—'}
                  </td>
                  <td>
                    {cloned ? (
                      <span className="status status-done">yes</span>
                    ) : (
                      <span className="status status-queued">not yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
};

export default ReposPage;
