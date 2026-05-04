import Link from 'next/link';
import type { ReactNode } from 'react';

import { ChevronRightIcon } from './icons';

/**
 * `apps/web/components/ui/Breadcrumbs.tsx` — typed crumb trail.
 *
 * Sentence-case labels; brand-color hover; aria-current on the
 * trailing crumb. Mounted on routes ≥3 levels deep.
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
    <nav aria-label="Breadcrumb" className="-mb-2 flex items-center gap-1 text-xs text-text-tertiary">
      <ol className="flex flex-wrap items-center gap-1">
        {trail.map((c, i) => {
          const isLast = i === trail.length - 1;
          const labelEl: ReactNode = c.mono === true ? <span className="font-mono">{c.label}</span> : c.label;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: trail order is stable per page render and labels can repeat
            <li key={`crumb-${i}-${c.label}`} className="flex items-center gap-1">
              {i > 0 ? <ChevronRightIcon className="h-3 w-3 text-text-muted" /> : null}
              {isLast || c.href === undefined ? (
                <span aria-current={isLast ? 'page' : undefined} className="font-medium text-text-primary">
                  {labelEl}
                </span>
              ) : (
                <Link href={c.href as never} className="transition-colors duration-150 hover:text-brand">
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
