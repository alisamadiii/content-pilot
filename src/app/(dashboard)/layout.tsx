import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { auth } from '@/lib/auth';
import { NavLinks } from './nav-links';

export const dynamic = 'force-dynamic';

const DashboardLayout = async ({ children }: { children: ReactNode }) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          content<span>-pilot</span>
        </div>
        <NavLinks />
        <div className="bottom">
          <div className="muted" style={{ fontSize: 12, padding: '6px 8px' }}>
            {session.user.email}
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
};

export default DashboardLayout;
