import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/EmptyState.tsx` — canonical empty-state
 * card (M04 Phase 2 UI).
 *
 * Replaces the per-page hand-rolled "no items" cards. One shape, with
 * optional icon, headline, descriptive body copy, and a single CTA.
 *
 * Two sizes:
 *   - `md` — default for in-page sections (pack list, runs list, etc.)
 *   - `lg` — used for hero-empty surfaces (graphify missing index, no
 *           projects yet on /).
 */

export interface EmptyStateProps {
  readonly title: string;
  readonly body?: ReactNode;
  /** Single ReactNode rendered above the title (centred). */
  readonly icon?: ReactNode;
  /** Single CTA — render a <LinkButton> or <Button>. */
  readonly action?: ReactNode;
  readonly size?: 'md' | 'lg';
}

export function EmptyState({ title, body, icon, action, size = 'md' }: EmptyStateProps) {
  const padding = size === 'lg' ? 'p-12' : 'p-8';
  return (
    <div
      className={`flex flex-col items-center gap-3 border border-(--color-border-subtle) bg-(--color-bg-surface) text-center ${padding}`}
    >
      {icon !== undefined ? <div className="text-(--color-text-tertiary)">{icon}</div> : null}
      <h3 className="font-display text-base font-bold uppercase tracking-widest text-(--color-text-secondary)">
        {title}
      </h3>
      {body !== undefined ? <p className="max-w-prose text-sm text-(--color-text-tertiary)">{body}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
