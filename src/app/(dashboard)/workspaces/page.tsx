import { like } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { repoColor } from '@/lib/repo-color';
import { listWorkspaces } from '@/lib/repos';
import { AppDirForm, DeleteCloneButton } from './repo-actions';

export const dynamic = 'force-dynamic';

const ReposPage = async () => {
  const [rows, appDirRows] = await Promise.all([
    listWorkspaces(),
    db.select().from(appSetting).where(like(appSetting.key, 'app_dir:%')),
  ]);
  const appDirs = new Map(
    appDirRows.map((r) => [Number(r.key.slice('app_dir:'.length)), r.value])
  );

  return (
    <>
      <h1>workspaces</h1>
      <p className="subtitle">
        derived from the workspace + job/session history
      </p>
      {rows.length === 0 ? (
        <div className="card muted">
          No workspaces yet — a folder appears here once a job or session clones
          the repo into the workspace.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>repo id</th>
              <th>owner</th>
              <th>repository</th>
              <th>branch</th>
              <th>jobs</th>
              <th>last job</th>
              <th>app folder</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.repoId}>
                  <td className="muted">{row.repoId}</td>
                  <td>{row.owner}</td>
                  <td>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: repoColor(row.owner, row.repo),
                        marginRight: 6,
                        verticalAlign: 'middle',
                      }}
                    />
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
                      ? row.lastJobAt.toISOString().replace('T', ' ').slice(0, 19)
                      : '—'}
                  </td>
                  <td>
                    <AppDirForm
                      repoId={row.repoId}
                      value={appDirs.get(row.repoId) ?? ''}
                    />
                  </td>
                  <td>
                    <DeleteCloneButton
                      repoId={row.repoId}
                      label={`${row.owner}/${row.repo}`}
                    />
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
