'use client';

import { useState, useTransition } from 'react';
import { deleteRepoClone, setGeminiTier, setProvider } from './actions';

export const ProviderForm = ({
  projectId,
  value,
}: {
  projectId: string;
  value: 'claude' | 'gemini';
}) => {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<'claude' | 'gemini'>(value);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <select
        value={current}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as 'claude' | 'gemini';
          const prev = current;
          setCurrent(next);
          setError(null);
          startTransition(async () => {
            try {
              await setProvider(projectId, next);
            } catch (err) {
              setCurrent(prev);
              setError(err instanceof Error ? err.message : 'Could not save.');
            }
          });
        }}
        style={{ width: 110 }}
      >
        <option value="gemini">Gemini</option>
        <option value="claude">Claude</option>
      </select>
      {pending && <span className="muted" style={{ fontSize: 12 }}>...</span>}
      {error && (
        <span className="error-text" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
};

export const GeminiTierForm = ({
  projectId,
  value,
  disabled = false,
}: {
  projectId: string;
  value: 'free' | 'paid';
  disabled?: boolean;
}) => {
  const [pending, startTransition] = useTransition();
  const [current, setCurrent] = useState<'free' | 'paid'>(value);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <select
        value={current}
        disabled={pending || disabled}
        onChange={(e) => {
          const next = e.target.value as 'free' | 'paid';
          const prev = current;
          setCurrent(next);
          setError(null);
          startTransition(async () => {
            try {
              await setGeminiTier(projectId, next);
            } catch (err) {
              setCurrent(prev);
              setError(err instanceof Error ? err.message : 'Could not save.');
            }
          });
        }}
        style={{ width: 90 }}
      >
        <option value="free">Free</option>
        <option value="paid">Paid</option>
      </select>
      {pending && <span className="muted" style={{ fontSize: 12 }}>...</span>}
      {error && (
        <span className="error-text" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
};

export const DeleteCloneButton = ({
  projectId,
  label,
}: {
  projectId: string;
  label: string;
}) => {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ gap: 8 }}>
      <button
        className="danger"
        type="button"
        disabled={pending}
        onClick={() => {
          if (
            !confirm(
              `Permanently delete the clone of ${label}?\n\nThis removes the entire project folder from this server's workspace. It will be re-cloned fresh the next time a job or session runs. This cannot be undone.`
            )
          ) {
            return;
          }
          setError(null);
          startTransition(async () => {
            try {
              await deleteRepoClone(projectId);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not delete.');
            }
          });
        }}
      >
        {pending ? '...' : 'delete'}
      </button>
      {error && (
        <span className="error-text" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
};
