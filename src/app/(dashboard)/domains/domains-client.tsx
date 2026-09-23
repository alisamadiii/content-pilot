'use client';

import { useState, useTransition } from 'react';
import {
  addDomainAction,
  registerSiteAction,
  removeDomainAction,
  type ActionResult,
} from './actions';

const errorOf = (result: ActionResult) => (result.ok ? null : result.error);

export const RegisterSiteForm = () => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          const result = await registerSiteAction(formData);
          setError(errorOf(result));
          if (result.ok) {
            (document.getElementById('register-site-form') as HTMLFormElement)?.reset();
          }
        });
      }}
      id="register-site-form"
    >
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input type="text" name="owner" placeholder="owner (e.g. acme-inc)" required style={{ maxWidth: 180 }} />
        <input type="text" name="repo" placeholder="repo (e.g. website)" required style={{ maxWidth: 180 }} />
        <input type="number" name="repoId" placeholder="github repo id" required style={{ maxWidth: 140 }} />
        <input type="text" name="branch" placeholder="branch (main)" style={{ maxWidth: 120 }} />
        <input type="text" name="domain" placeholder="https://acme.com (optional)" style={{ maxWidth: 220 }} />
        <button className="primary" type="submit" disabled={pending}>
          {pending ? '...' : 'register site'}
        </button>
      </div>
      {error && (
        <div className="muted" style={{ color: '#e5484d', fontSize: 12, marginTop: 6 }}>
          {error}
        </div>
      )}
    </form>
  );
};

export const AddDomainForm = ({ repoId }: { repoId: number }) => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');

  return (
    <form
      className="row"
      action={(formData) => {
        startTransition(async () => {
          const result = await addDomainAction(formData);
          setError(errorOf(result));
          if (result.ok) setValue('');
        });
      }}
    >
      <input type="hidden" name="repoId" value={repoId} />
      <input
        type="text"
        name="domain"
        placeholder="https://acme.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ maxWidth: 240 }}
      />
      <button type="submit" disabled={pending}>
        {pending ? '...' : 'add domain'}
      </button>
      {error && (
        <span className="muted" style={{ color: '#e5484d', fontSize: 12 }}>
          {error}
        </span>
      )}
    </form>
  );
};

export const RemoveDomainButton = ({
  repoId,
  origin,
}: {
  repoId: number;
  origin: string;
}) => {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await removeDomainAction(formData);
        });
      }}
      style={{ display: 'inline' }}
    >
      <input type="hidden" name="repoId" value={repoId} />
      <input type="hidden" name="domain" value={origin} />
      <button
        type="submit"
        disabled={pending}
        title="remove"
        style={{
          border: 'none',
          background: 'none',
          cursor: 'pointer',
          color: '#e5484d',
          padding: '0 4px',
        }}
      >
        {pending ? '…' : '×'}
      </button>
    </form>
  );
};
