import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { apiKey } from '@/db/schema';
import {
  CreateKeyForm,
  DeleteKeyButton,
  RevokeKeyButton,
} from './settings-client';

export const dynamic = 'force-dynamic';

const SettingsPage = async () => {
  const keys = await db
    .select()
    .from(apiKey)
    .orderBy(desc(apiKey.createdAt));

  return (
    <>
      <h1>settings</h1>
      <p className="subtitle">API keys and worker configuration</p>

      <div className="card">
        <div style={{ marginBottom: 12, fontWeight: 600 }}>API keys</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Callers (e.g. your client hub) authenticate with the{' '}
          <code>x-api-key</code> header. The plaintext key is shown once at
          creation.
        </p>
        <CreateKeyForm />
        {keys.length > 0 && (
          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>name</th>
                <th>created</th>
                <th>last used</th>
                <th>status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="muted">
                    {key.createdAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="muted">
                    {key.lastUsedAt
                      ? key.lastUsedAt.toISOString().replace('T', ' ').slice(0, 19)
                      : 'never'}
                  </td>
                  <td>
                    {key.revokedAt ? (
                      <span className="status status-failed">revoked</span>
                    ) : (
                      <span className="status status-done">active</span>
                    )}
                  </td>
                  <td>
                    <div className="row">
                      {!key.revokedAt && <RevokeKeyButton id={key.id} />}
                      <DeleteKeyButton id={key.id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div style={{ marginBottom: 12, fontWeight: 600 }}>worker config</div>
        <table>
          <tbody>
            <tr>
              <td className="muted">poll interval</td>
              <td>{Number(process.env.POLL_INTERVAL_MS) / 1000 || 60}s</td>
            </tr>
            <tr>
              <td className="muted">job timeout</td>
              <td>{Number(process.env.JOB_TIMEOUT_MS) / 1000 || 600}s</td>
            </tr>
            <tr>
              <td className="muted">workspace dir</td>
              <td>{process.env.WORKSPACE_DIR || './workspace'}</td>
            </tr>
            <tr>
              <td className="muted">claude binary</td>
              <td>{process.env.CLAUDE_BIN || 'claude'}</td>
            </tr>
            <tr>
              <td className="muted">github pat</td>
              <td>{process.env.GITHUB_PAT ? 'configured' : 'MISSING'}</td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>
          Values come from environment variables — change them in .env / Coolify
          and restart.
        </p>
      </div>
    </>
  );
};

export default SettingsPage;
