import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/EmptyState.tsx` — editorial empty-state card.
 *
 * Centered serif title with phosphor italic emphasis, mono body,
 * optional CTA. Square dashed border on bg-surface — empty but
 * actionable.
 */

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly body?: ReactNode;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly size?: 'md' | 'lg';
}

export function EmptyState({ title, body, icon, action, size = 'md' }: EmptyStateProps) {
  const padding = size === 'lg' ? 'py-16 px-10' : 'py-12 px-8';
  return (
    <div
      className={`flex flex-col items-center gap-4 border border-dashed border-rule-strong bg-bg-surface text-center ${padding}`}
    >
      {icon !== undefined ? (
        <div className="flex h-10 w-10 items-center justify-center border border-rule-strong text-text-tertiary">
          {icon}
        </div>
      ) : null}
      <h3 className="heading-display text-[28px] text-text-primary">
        {typeof title === 'string' ? <span>{title}</span> : title}
      </h3>
      {body !== undefined ? <p className="max-w-prose text-[13px] leading-[1.6] text-text-tertiary">{body}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
