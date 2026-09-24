'use client';

import { useState, useTransition } from 'react';
import {
  createWebhookAction,
  deleteWebhookAction,
  toggleWebhookAction,
} from './actions';

type RepoOption = { repoId: number; owner: string; repo: string };

const EVENTS = ['done', 'rejected', 'failed'] as const;

export const CreateWebhookForm = ({ repos }: { repos: RepoOption[] }) => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          setError(null);
          try {
            await createWebhookAction(formData);
          } catch (e) {
            setError((e as Error).message);
          }
        });
      }}
    >
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <input
          type="text"
          name="name"
          placeholder="name (e.g. portfolio-hub)"
          style={{ maxWidth: 220 }}
        />
        <input
          type="url"
          name="url"
          placeholder="https://app.example.com/api/webhook/content-pilot"
          style={{ minWidth: 320, flex: 1 }}
        />
        <select name="repoId" defaultValue="">
          <option value="">all repos</option>
          {repos.map((repo) => (
            <option key={repo.repoId} value={repo.repoId}>
              {repo.owner}/{repo.repo}
            </option>
          ))}
        </select>
      </div>
      <div className="row" style={{ marginTop: 8, gap: 16 }}>
        {EVENTS.map((event) => (
          <label
            key={event}
            className="muted"
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}
          >
            <input
              type="checkbox"
              name="events"
              value={event}
              defaultChecked={event !== 'done'}
            />
            {event}
          </label>
        ))}
        <button className="primary" type="submit" disabled={pending}>
          {pending ? '...' : 'create webhook'}
        </button>
      </div>
      {error && (
        <div className="status status-failed" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </form>
  );
};

export const RevealSecret = ({ secret }: { secret: string }) => {
  const [shown, setShown] = useState(false);
  return shown ? (
    <span className="mono-key" style={{ fontSize: 12 }}>
      {secret}
    </span>
  ) : (
    <button type="button" onClick={() => setShown(true)}>
      reveal
    </button>
  );
};

export const ToggleWebhookButton = ({
  id,
  enabled,
}: {
  id: number;
  enabled: boolean;
}) => {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await toggleWebhookAction(formData);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={String(enabled)} />
      <button type="submit" disabled={pending}>
        {enabled ? 'disable' : 'enable'}
      </button>
    </form>
  );
};

export const DeleteWebhookButton = ({ id }: { id: number }) => {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        if (
          !confirm(
            'Permanently delete this webhook? Deliveries to it will stop and its secret is lost.'
          )
        ) {
          return;
        }
        startTransition(async () => {
          await deleteWebhookAction(formData);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="danger" type="submit" disabled={pending}>
        delete
      </button>
    </form>
  );
};
