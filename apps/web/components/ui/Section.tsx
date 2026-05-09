import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Section.tsx` — editorial content section.
 *
 * The section header borrows the brand-kit card-head pattern:
 *   serif italic title with phosphor emphasis on the left,
 *   mono uppercase role / count on the right.
 *
 * Use `<em>...</em>` inside `title` for italic phosphor emphasis.
 * `compact` shrinks the title for nested sections inside cards.
 */

export interface SectionProps {
  readonly title: ReactNode;
  readonly count?: ReactNode;
  readonly actions?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
  readonly compact?: boolean;
}

export function Section({ title, count, actions, subtitle, children, compact }: SectionProps) {
  const titleSize = compact === true ? 'text-[18px]' : 'text-[28px]';
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2
            className={`heading-display ${titleSize} text-text-primary`}
            style={{ lineHeight: compact === true ? 1.2 : 1.05 }}
          >
            {typeof title === 'string' ? <span>{title}</span> : title}
          </h2>
          {subtitle !== undefined ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-tertiary">{subtitle}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          {count !== undefined ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary">{count}</span>
          ) : null}
          {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
