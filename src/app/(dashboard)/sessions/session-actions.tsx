'use client';

import { useTransition } from 'react';
import type { PreviewSessionStatus } from '@/db/schema';
import { killSession } from './actions';

const LIVE: PreviewSessionStatus[] = [
  'starting',
  'installing',
  'ready',
  'restarting',
];

export const SessionActions = ({
  id,
  status,
}: {
  id: string;
  status: PreviewSessionStatus;
}) => {
  const [pending, startTransition] = useTransition();

  if (!LIVE.includes(status)) {
    return null;
  }

  return (
    <button
      type="button"
      disabled={pending}
      title="End this session now — kills its dev server and frees the slot. Unpublished changes stay on the preview branch."
      onClick={() => {
        if (
          window.confirm(
            "Kill this session? The client's live preview will end and any unpublished changes will not go live."
          )
        ) {
          startTransition(() => killSession(id));
        }
      }}
    >
      {pending ? 'killing…' : 'kill'}
    </button>
  );
};
