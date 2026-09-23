'use client';

import { useTransition } from 'react';
import type { JobStatus } from '@/db/schema';
import { retryJob, runJobNow } from './actions';

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
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => retryJob(id))}
      >
        {pending ? '...' : 'retry'}
      </button>
    );
  }

  return null;
};
