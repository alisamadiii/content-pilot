'use client';

import { useState, useTransition } from 'react';
import { deleteRepoClone, setAppDir } from './actions';

export const AppDirForm = ({
  repoId,
  value,
}: {
  repoId: number;
  value: string;
}) => {
  const [pending, startTransition] = useTransition();
  const [input, setInput] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const dirty = input.trim() !== value;
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <input
        type="text"
        value={input}
        placeholder="auto"
        disabled={pending}
        onChange={(e) => setInput(e.target.value)}
        style={{ width: 120 }}
      />
      <button
        type="button"
        disabled={pending || !dirty}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await setAppDir(repoId, input);
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Could not save.');
            }
          });
        }}
      >
        {pending ? '...' : 'save'}
      </button>
      {error && (
        <span className="error-text" style={{ fontSize: 12 }}>
          {error}
        </span>
      )}
    </div>
  );
};

export const DeleteCloneButton = ({
  repoId,
  label,
}: {
  repoId: number;
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
              await deleteRepoClone(repoId);
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
