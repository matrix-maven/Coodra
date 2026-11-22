'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Live tail for the raw events view. It does not stream: while enabled it re-renders the server
 * page every few seconds, so what you see is always a fresh read of the local database.
 */
export function LiveTail({
  enabled,
  onHref,
  offHref,
  intervalMs = 3000,
}: {
  readonly enabled: boolean;
  readonly onHref: string;
  readonly offHref: string;
  readonly intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs, router]);

  return (
    <Link href={enabled ? offHref : onHref} className="badge" prefetch={false}>
      <span className="badge__dot" />
      {enabled ? `live · every ${intervalMs / 1000}s — click to pause` : 'paused — click for live tail'}
    </Link>
  );
}
