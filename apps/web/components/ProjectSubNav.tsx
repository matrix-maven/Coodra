'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * `apps/web/components/ProjectSubNav.tsx` — project-scoped secondary
 * navigation row (M04 Phase 2 S2c).
 *
 * Renders inside `apps/web/app/projects/[slug]/layout.tsx`. Highlights
 * the active section by inspecting `usePathname()` against the
 * link's segment after the slug.
 *
 * Sections marked `(coming)` are placeholders for future Phase 2
 * slices — the link is rendered in muted color and goes to a 404
 * for now (S8/S9/S10/S11/S14 implement them).
 */

export interface ProjectSubNavProps {
  readonly projectSlug: string;
}

interface SubNavItem {
  readonly segment: string;
  readonly label: string;
  readonly status: 'live' | 'coming';
}

const ITEMS: ReadonlyArray<SubNavItem> = [
  { segment: '', label: 'Home', status: 'live' },
  { segment: 'runs', label: 'Runs', status: 'live' },
  { segment: 'policies', label: 'Policies', status: 'live' },
  { segment: 'packs', label: 'Packs', status: 'live' },
  { segment: 'context-packs', label: 'Context packs', status: 'live' },
  { segment: 'templates', label: 'Templates', status: 'live' },
  { segment: 'kill-switches', label: 'Kill switches', status: 'live' },
  { segment: 'graph', label: 'Graph', status: 'coming' },
  { segment: 'doctor', label: 'Doctor', status: 'live' },
  { segment: 'logs', label: 'Logs', status: 'coming' },
  { segment: 'settings', label: 'Settings', status: 'live' },
];

export function ProjectSubNav({ projectSlug }: ProjectSubNavProps) {
  const pathname = usePathname();
  const baseHref = `/projects/${encodeURIComponent(projectSlug)}`;
  const activeSegment = extractActiveSegment(pathname, projectSlug);
  return (
    <nav className="border-b border-(--color-border-subtle) bg-(--color-bg-surface)">
      <ul className="mx-auto flex max-w-[1200px] items-center gap-1 overflow-x-auto px-8">
        {ITEMS.map((item) => {
          const href = item.segment === '' ? baseHref : `${baseHref}/${item.segment}`;
          const isActive = item.segment === activeSegment;
          const isComing = item.status === 'coming';
          const cls = [
            'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-3 font-display text-xs font-bold uppercase tracking-widest transition-colors',
            isActive
              ? 'border-(--color-brand) text-(--color-brand)'
              : 'border-transparent text-(--color-text-secondary) hover:border-(--color-border-default) hover:text-(--color-text-primary)',
            isComing ? 'opacity-50' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={item.segment}>
              <Link href={href as never} className={cls}>
                {item.label}
                {isComing ? <span className="font-mono text-[9px] font-normal lowercase">soon</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Extract the project sub-section from `pathname`. Returns '' for the
 * project home.
 *
 *     /projects/coodra-dev          → ''
 *     /projects/coodra-dev/runs     → 'runs'
 *     /projects/coodra-dev/runs/[id] → 'runs'
 *     /projects/coodra-dev/packs/foo/edit → 'packs'
 */
function extractActiveSegment(pathname: string, slug: string): string {
  const prefix = `/projects/${encodeURIComponent(slug)}`;
  if (!pathname.startsWith(prefix)) return '';
  const tail = pathname.slice(prefix.length);
  if (tail === '' || tail === '/') return '';
  // tail is like '/runs', '/runs/abc', '/packs/foo/edit'
  const next = tail.split('/').filter(Boolean)[0];
  return next ?? '';
}
