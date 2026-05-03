import Link from 'next/link';

import type { Actor } from '@/lib/auth';
import { SoloModeBadge } from './SoloModeBadge';

/**
 * Top header chrome per `docs/feature-packs/04-web-app/wireframes/01-nav-map.md`.
 * S1 ships the static layout with no active-route indicator; the active
 * highlight wires up in S3 (when there's more than one real route to
 * highlight).
 */

const NAV_ITEMS = [
  { href: '/runs', label: 'Runs' },
  { href: '/policies', label: 'Policies' },
  { href: '/projects', label: 'Projects' },
  { href: '/packs', label: 'Packs' },
  { href: '/templates', label: 'Templates' },
  { href: '/kill-switches', label: 'Kill switches' },
] as const;

export interface HeaderNavProps {
  readonly actor: Actor;
}

export function HeaderNav({ actor }: HeaderNavProps) {
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-6">
      <div className="flex items-center gap-6">
        <Link
          href="/"
          className="font-display text-base font-black uppercase tracking-wider text-(--color-text-primary)"
        >
          [CTX]<span className="text-(--color-brand)">OS</span>
        </Link>
        <span className="font-display text-xs font-light uppercase tracking-widest text-(--color-text-secondary)">
          {actor.orgId === '__solo__' ? 'verify-m08b' : actor.orgId}
        </span>
      </div>

      <nav className="hidden items-center gap-6 md:flex">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-primary) hover:text-(--color-brand)"
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-4">{actor.mode === 'solo' ? <SoloModeBadge /> : null}</div>
    </header>
  );
}
