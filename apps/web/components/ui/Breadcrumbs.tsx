import Link from 'next/link';
import type { ReactNode } from 'react';

import { ChevronRightIcon } from './icons/ChevronRightIcon';

/**
 * `apps/web/components/ui/Breadcrumbs.tsx` — typed crumb trail
 * (M04 Phase 2 UI a11y).
 *
 * Pages pass an explicit list of crumbs (vs. parsing pathname) so the
 * label is always meaningful — e.g. a pack-edit page renders
 * "Projects · coodra-dev · Packs · 04-web-app · Edit" with each crumb
 * clickable except the last (current location).
 *
 * Per the skill's Navigation/Breadcrumbs rule: only used for routes
 * with 3+ levels of nesting. Currently mounted on:
 *   - /projects/[slug]/packs/[packSlug]
 *   - /projects/[slug]/packs/[packSlug]/edit
 *   - /projects/[slug]/packs/[packSlug]/runs
 *   - /projects/[slug]/context-packs/[id]
 *   - /projects/[slug]/logs/[service]
 *   - /projects/[slug]/runs/[id]
 *   - /projects/[slug]/settings/export
 */

export interface Crumb {
  readonly label: string;
  /** Omit on the last (current) crumb to render as plain text. */
  readonly href?: string;
  /** Wrap label in mono if true (used for slugs / IDs). */
  readonly mono?: boolean;
}

export interface BreadcrumbsProps {
  readonly trail: ReadonlyArray<Crumb>;
}

export function Breadcrumbs({ trail }: BreadcrumbsProps) {
  if (trail.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="-mb-2 flex items-center gap-1 text-xs text-(--color-text-secondary)">
      <ol className="flex flex-wrap items-center gap-1">
        {trail.map((c, i) => {
          const isLast = i === trail.length - 1;
          const labelEl: ReactNode = c.mono === true ? <span className="font-mono">{c.label}</span> : c.label;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: trail order is stable per page render and labels can repeat (e.g. dup slugs)
            <li key={`crumb-${i}-${c.label}`} className="flex items-center gap-1">
              {i > 0 ? <ChevronRightIcon className="h-3 w-3 text-(--color-text-tertiary)" /> : null}
              {isLast || c.href === undefined ? (
                <span aria-current={isLast ? 'page' : undefined} className="text-(--color-text-primary)">
                  {labelEl}
                </span>
              ) : (
                <Link href={c.href as never} className="transition-colors duration-200 hover:text-(--color-brand)">
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
