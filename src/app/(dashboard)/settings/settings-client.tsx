'use client';

import { useState, useTransition } from 'react';
import { createApiKeyAction, revokeApiKeyAction } from './actions';

export const CreateKeyForm = () => {
  const [pending, startTransition] = useTransition();
  const [created, setCreated] = useState<{ name: string; plaintext: string } | null>(
    null
  );
  const [name, setName] = useState('');

  return (
    <div>
      <form
        className="row"
        action={(formData) => {
          startTransition(async () => {
            const result = await createApiKeyAction(formData);
            setCreated(result);
            setName('');
          });
        }}
      >
        <input
          type="text"
          name="name"
          placeholder="key name (e.g. client-hub)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? '...' : 'create key'}
        </button>
      </form>
      {created && (
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            key “{created.name}” — copy it now, it will not be shown again:
          </div>
          <div className="mono-key">{created.plaintext}</div>
        </div>
      )}
    </div>
  );
};

export const RevokeKeyButton = ({ id }: { id: number }) => {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await revokeApiKeyAction(formData);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="danger" type="submit" disabled={pending}>
        revoke
      </button>
    </form>
  );
};
