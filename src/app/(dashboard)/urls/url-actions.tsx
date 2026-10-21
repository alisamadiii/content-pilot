'use client';

import { useTransition } from 'react';
import { endPreview, removeDomain, takeLiveSiteDown } from './actions';

export type UrlTarget =
  | { kind: 'live site'; repoId: number }
  | { kind: 'free subdomain' | 'custom domain'; host: string }
  | { kind: 'editing preview'; sessionId: string };

const CONFIRM: Record<UrlTarget['kind'], string> = {
  'live site':
    'Take this live site offline? Its built files are deleted and its domains show "not published yet" until the next publish.',
  'free subdomain':
    'Stop serving this subdomain? The hub still lists it in the Domain tab until it is removed there.',
  'custom domain':
    'Stop serving this custom domain? The hub still lists it and the Cloudflare hostname stays until it is removed in the Domain tab.',
  'editing preview':
    "End this editing preview? The client's preview closes and unpublished changes stay on the preview branch.",
};

const LABEL: Record<UrlTarget['kind'], string> = {
  'live site': 'take down',
  'free subdomain': 'remove',
  'custom domain': 'remove',
  'editing preview': 'end',
};

/** Per-row destructive action on the urls page, always behind a confirm. */
export const UrlAction = ({
  target,
  url,
}: {
  target: UrlTarget;
  url: string;
}) => {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="danger"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`${CONFIRM[target.kind]}\n\n${url}`)) return;
        startTransition(async () => {
          if (target.kind === 'live site')
            await takeLiveSiteDown(target.repoId);
          else if (target.kind === 'editing preview')
            await endPreview(target.sessionId);
          else await removeDomain(target.host);
        });
      }}
    >
      {pending ? '…' : LABEL[target.kind]}
    </button>
  );
};
