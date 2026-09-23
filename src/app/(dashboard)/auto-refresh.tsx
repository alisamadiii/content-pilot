'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export const AutoRefresh = ({ seconds = 10 }: { seconds?: number }) => {
  const router = useRouter();

  useEffect(() => {
    const interval = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(interval);
  }, [router, seconds]);

  return null;
};
