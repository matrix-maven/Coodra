import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Section.tsx` — page sub-section with h2 +
 * optional count chip + optional right-aligned actions (M04 Phase 2 UI).
 *
 * Replaces the ~14 hand-rolled <section> wrappers that drifted across
 * pages. Children get a fixed vertical stack; outer rhythm comes from
 * the parent <PageShell>.
 */

export interface SectionProps {
  readonly title: string;
  /** Small monospace count next to the title (e.g. "12 / 12+"). */
  readonly count?: string | number;
  /** Right-aligned action slot. */
  readonly actions?: ReactNode;
  /** Subtitle / descriptive helper text under the title. */
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
}

export function Section({ title, count, actions, subtitle, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-(--space-stack)">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">
            {title}
          </h2>
          {count !== undefined ? <span className="font-mono text-xs text-(--color-text-tertiary)">{count}</span> : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle !== undefined ? <p className="text-sm text-(--color-text-secondary)">{subtitle}</p> : null}
      {children}
    </section>
  );
}
