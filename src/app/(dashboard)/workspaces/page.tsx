import { like } from 'drizzle-orm';
import { db } from '@/db';
import { appSetting } from '@/db/schema';
import { repoColor } from '@/lib/repo-color';
import { listWorkspaces } from '@/lib/repos';
import {
  AppDirForm,
  DeleteCloneButton,
  GeminiTierForm,
  ProviderForm,
} from './repo-actions';

export const dynamic = 'force-dynamic';

const ReposPage = async () => {
  const [rows, appDirRows, providerRows, tierRows, domainRows] =
    await Promise.all([
      listWorkspaces(),
      db.select().from(appSetting).where(like(appSetting.key, 'app_dir:%')),
      db.select().from(appSetting).where(like(appSetting.key, 'ai_provider:%')),
      db.select().from(appSetting).where(like(appSetting.key, 'gemini_tier:%')),
      db.select().from(appSetting).where(like(appSetting.key, 'domain:%')),
    ]);
  const appDirs = new Map(
    appDirRows.map((r) => [Number(r.key.slice('app_dir:'.length)), r.value])
  );
  // Default gemini; only an explicit `claude` value selects Claude.
  const providers = new Map(
    providerRows.map((r) => [
      Number(r.key.slice('ai_provider:'.length)),
      r.value === 'claude' ? 'claude' : 'gemini',
    ])
  );
  // Default free; only an explicit `paid` value selects the paid key.
  const tiers = new Map(
    tierRows.map((r) => [
      Number(r.key.slice('gemini_tier:'.length)),
      r.value === 'paid' ? 'paid' : 'free',
    ])
  );
  // Upload-project domain mappings, grouped per repoId (read-only here; the
  // hub writes them).
  const domains = new Map<number, string[]>();
  for (const r of domainRows) {
    const repoId = Number(r.value);
    const host = r.key.slice('domain:'.length);
    if (!Number.isSafeInteger(repoId)) continue;
    domains.set(repoId, [...(domains.get(repoId) ?? []), host]);
  }

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
              <th>repo id</th>
              <th>owner</th>
              <th>repository</th>
              <th>branch</th>
              <th>app folder</th>
              <th>domains</th>
              <th>ai</th>
              <th>gemini key</th>
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
                  <td>
                    <AppDirForm
                      repoId={row.repoId}
                      value={appDirs.get(row.repoId) ?? ''}
                    />
                  </td>
                  <td className="muted">
                    {domains.get(row.repoId)?.join(', ') ?? '-'}
                  </td>
                  <td>
                    <ProviderForm
                      repoId={row.repoId}
                      value={
                        (providers.get(row.repoId) ?? 'gemini') as
                          | 'claude'
                          | 'gemini'
                      }
                    />
                  </td>
                  <td>
                    <GeminiTierForm
                      repoId={row.repoId}
                      value={
                        (tiers.get(row.repoId) ?? 'free') as 'free' | 'paid'
                      }
                      disabled={
                        (providers.get(row.repoId) ?? 'gemini') === 'claude'
                      }
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
