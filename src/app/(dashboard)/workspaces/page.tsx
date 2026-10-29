import { like } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { repoColor } from '@/lib/repo-color';
import { listWorkspaces } from '@/lib/repos';
import { DeleteCloneButton, GeminiTierForm, ProviderForm } from './repo-actions';

export const dynamic = 'force-dynamic';

const ReposPage = async () => {
  const [rows, providerRows, tierRows] =
    await Promise.all([
      listWorkspaces(),
      db.select().from(appSetting).where(like(appSetting.key, 'ai_provider:%')),
      db.select().from(appSetting).where(like(appSetting.key, 'gemini_tier:%')),
    ]);
  // Default gemini; only an explicit `claude` value selects Claude.
  const providers = new Map(
    providerRows.map((r) => [
      r.key.slice('ai_provider:'.length),
      r.value === 'claude' ? 'claude' : 'gemini',
    ])
  );
  // Default free; only an explicit `paid` value selects the paid key.
  const tiers = new Map(
    tierRows.map((r) => [
      r.key.slice('gemini_tier:'.length),
      r.value === 'paid' ? 'paid' : 'free',
    ])
  );

  return (
    <>
      <h1>workspaces</h1>
      <p className="subtitle">repo clones on disk in the workspace folder</p>
      {rows.length === 0 ? (
        <div className="card muted">
          No workspaces yet — a folder appears here once a session clones the
          repo into the workspace.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>project id</th>
              <th>owner</th>
              <th>repository</th>
              <th>branch</th>
              <th>ai</th>
              <th>gemini key</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
                <tr key={row.projectId}>
                  <td className="muted">{row.projectId}</td>
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
                  <td>
                    <ProviderForm
                      projectId={row.projectId}
                      value={
                        (providers.get(row.projectId) ?? 'gemini') as
                          | 'claude'
                          | 'gemini'
                      }
                    />
                  </td>
                  <td>
                    <GeminiTierForm
                      projectId={row.projectId}
                      value={
                        (tiers.get(row.projectId) ?? 'free') as 'free' | 'paid'
                      }
                      disabled={
                        (providers.get(row.projectId) ?? 'gemini') === 'claude'
                      }
                    />
                  </td>
                  <td>
                    <DeleteCloneButton
                      projectId={row.projectId}
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
