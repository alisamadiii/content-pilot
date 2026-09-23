'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

const links = [
  { href: '/jobs', label: 'jobs' },
  { href: '/repos', label: 'repos' },
  { href: '/settings', label: 'settings' },
];

export const NavLinks = () => {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={pathname.startsWith(link.href) ? 'active' : ''}
        >
          {link.label}
        </Link>
      ))}
      <a
        href="/login"
        onClick={async (e) => {
          e.preventDefault();
          await authClient.signOut();
          router.push('/login');
          router.refresh();
        }}
      >
        logout
      </a>
    </>
  );
};
