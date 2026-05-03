'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Breadcrumb track per `docs/feature-packs/04-web-app/wireframes/00-information-architecture.md`.
 * Renders below the header. Splits the current pathname on `/` and links
 * each segment except the last to its parent path. Mono caption.
 */

export function Breadcrumb() {
  const pathname = usePathname();
  if (pathname === '/' || pathname === '/not-found') return null;
  const segments = pathname.split('/').filter(Boolean);
  return (
    <div className="sticky top-14 z-10 border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-6 py-2 font-mono text-xs">
      {segments.map((seg, idx) => {
        const isLast = idx === segments.length - 1;
        const href = `/${segments.slice(0, idx + 1).join('/')}`;
        return (
          <span key={href}>
            {isLast ? (
              <span className="text-(--color-text-primary)">{seg}</span>
            ) : (
              <Link href={href} className="text-(--color-brand) hover:text-(--color-brand-hover)">
                {seg}
              </Link>
            )}
            {!isLast ? <span className="text-(--color-text-tertiary)"> / </span> : null}
          </span>
        );
      })}
    </div>
  );
}
