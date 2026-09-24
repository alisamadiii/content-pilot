'use client';

import { useTransition } from 'react';
import type { JobStatus } from '@/db/schema';
import { retryJob, retryJobUnrestricted, runJobNow } from './actions';

export const JobActions = ({
  id,
  status,
}: {
  id: number;
  status: JobStatus;
}) => {
  const [pending, startTransition] = useTransition();

  if (status === 'queued') {
    return (
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => runJobNow(id))}
      >
        {pending ? '...' : 'run now'}
      </button>
    );
  }

  if (status === 'failed' || status === 'rejected' || status === 'canceled') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(() => retryJob(id))}
        >
          {pending ? '...' : 'retry'}
        </button>
        {status === 'rejected' && (
          <button
            type="button"
            disabled={pending}
            title="Re-run this job with the guardrails off — the request will be allowed even though it's outside the normal content-only scope."
            onClick={() => startTransition(() => retryJobUnrestricted(id))}
          >
            {pending ? '...' : 'retry without limits'}
          </button>
        )}
      </div>
    );
  }

  return null;
};
