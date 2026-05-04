import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Section.tsx` — content section with h2 +
 * optional count + actions. Sentence-case heading; soft visual.
 */

export interface SectionProps {
  readonly title: string;
  readonly count?: string | number;
  readonly actions?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
}

export function Section({ title, count, actions, subtitle, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-(--space-stack)">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-base font-semibold tracking-tight text-text-primary">{title}</h2>
          {count !== undefined ? (
            <span className="rounded-full bg-bg-elevated px-2 py-0.5 font-mono text-[11px] font-medium text-text-tertiary">
              {count}
            </span>
          ) : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle !== undefined ? <p className="-mt-1 text-sm text-text-secondary">{subtitle}</p> : null}
      {children}
    </section>
  );
}
