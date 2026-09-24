import { desc } from 'drizzle-orm';
import { db } from '@/db';
import { repo, webhook, webhookDelivery } from '@/db/schema';
import {
  CreateWebhookForm,
  DeleteWebhookButton,
  RevealSecret,
  ToggleWebhookButton,
} from './webhooks-client';

export const dynamic = 'force-dynamic';

const parseEvents = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const WebhooksPage = async () => {
  const [hooks, repos, deliveries] = await Promise.all([
    db.select().from(webhook).orderBy(desc(webhook.createdAt)),
    db.select().from(repo).orderBy(desc(repo.updatedAt)),
    db
      .select()
      .from(webhookDelivery)
      .orderBy(desc(webhookDelivery.createdAt))
      .limit(50),
  ]);

  const repoName = new Map(
    repos.map((r) => [r.repoId, `${r.owner}/${r.repo}`])
  );
  const hookName = new Map(hooks.map((h) => [h.id, h.name]));

  return (
    <>
      <h1>webhooks</h1>
      <p className="subtitle">
        notify downstream apps when a job is done, rejected or failed
      </p>

      <div className="card">
        <div style={{ marginBottom: 12, fontWeight: 600 }}>webhooks</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Each request is signed with the webhook secret in the{' '}
          <code>x-content-pilot-signature</code> header (
          <code>sha256=&lt;hmac&gt;</code>). The receiver verifies it with the
          same secret. Scope a webhook to one repo or fire it for all.
        </p>
        <CreateWebhookForm repos={repos} />
        {hooks.length > 0 && (
          <table style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>name</th>
                <th>url</th>
                <th>scope</th>
                <th>events</th>
                <th>secret</th>
                <th>status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((hook) => (
                <tr key={hook.id}>
                  <td>{hook.name}</td>
                  <td className="muted" style={{ maxWidth: 260, wordBreak: 'break-all' }}>
                    {hook.url}
                  </td>
                  <td className="muted">
                    {hook.repoId === null
                      ? 'all repos'
                      : (repoName.get(hook.repoId) ?? `repo ${hook.repoId}`)}
                  </td>
                  <td className="muted">{parseEvents(hook.events).join(', ')}</td>
                  <td>
                    <RevealSecret secret={hook.secret} />
                  </td>
                  <td>
                    {hook.enabled ? (
                      <span className="status status-done">enabled</span>
                    ) : (
                      <span className="status status-failed">disabled</span>
                    )}
                  </td>
                  <td>
                    <div className="row">
                      <ToggleWebhookButton id={hook.id} enabled={hook.enabled} />
                      <DeleteWebhookButton id={hook.id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div style={{ marginBottom: 12, fontWeight: 600 }}>
          recent deliveries
        </div>
        {deliveries.length === 0 ? (
          <p className="muted" style={{ marginTop: 0 }}>
            No deliveries yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>webhook</th>
                <th>event</th>
                <th>job</th>
                <th>result</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => {
                const ok =
                  delivery.responseStatus !== null &&
                  delivery.responseStatus >= 200 &&
                  delivery.responseStatus < 300;
                return (
                  <tr key={delivery.id}>
                    <td className="muted">
                      {delivery.createdAt
                        .toISOString()
                        .replace('T', ' ')
                        .slice(0, 19)}
                    </td>
                    <td>{hookName.get(delivery.webhookId) ?? delivery.webhookId}</td>
                    <td className="muted">{delivery.event}</td>
                    <td className="muted">
                      {delivery.jobId ? `#${delivery.jobId}` : '—'}
                    </td>
                    <td>
                      {delivery.error ? (
                        <span className="status status-failed">
                          {delivery.error}
                        </span>
                      ) : (
                        <span
                          className={`status ${ok ? 'status-done' : 'status-failed'}`}
                        >
                          {delivery.responseStatus ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
};

export default WebhooksPage;
