import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/EmptyState.tsx` — empty-state card.
 *
 * Centered icon + sentence-case title + body + optional CTA. Soft
 * dashed border to communicate empty-but-actionable.
 */

export interface EmptyStateProps {
  readonly title: string;
  readonly body?: ReactNode;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly size?: 'md' | 'lg';
}

export function EmptyState({ title, body, icon, action, size = 'md' }: EmptyStateProps) {
  const padding = size === 'lg' ? 'py-16 px-8' : 'py-12 px-6';
  return (
    <div
      className={`flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-default bg-bg-surface text-center ${padding}`}
    >
      {icon !== undefined ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-bg-elevated text-text-tertiary">
          {icon}
        </div>
      ) : null}
      <h3 className="font-display text-base font-semibold tracking-tight text-text-primary">{title}</h3>
      {body !== undefined ? <p className="max-w-prose text-sm text-text-secondary">{body}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
