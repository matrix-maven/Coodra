import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Breadcrumbs.tsx` — typed crumb trail.
 *
 * Mono uppercase tracking, slash separator, accent on the current
 * leaf. Used inline with editorial page headers (NOT inside the
 * topbar — that has its own breadcrumb pattern).
 */

export interface Crumb {
  readonly label: string;
  readonly href?: string;
  readonly mono?: boolean;
}

export interface BreadcrumbsProps {
  readonly trail: ReadonlyArray<Crumb>;
}

export function Breadcrumbs({ trail }: BreadcrumbsProps) {
  if (trail.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="-mb-2 flex items-center font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary"
    >
      <ol className="flex flex-wrap items-center">
        {trail.map((c, i) => {
          const isLast = i === trail.length - 1;
          const labelEl: ReactNode = c.label;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: trail order is stable per page render and labels can repeat
            <li key={`crumb-${i}-${c.label}`} className="flex items-center">
              {i > 0 ? <span className="mx-2 text-text-muted">/</span> : null}
              {isLast || c.href === undefined ? (
                <span aria-current={isLast ? 'page' : undefined} className="font-medium text-accent">
                  {labelEl}
                </span>
              ) : (
                <Link href={c.href as never} className="transition-colors duration-150 hover:text-text-primary">
                  {labelEl}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
