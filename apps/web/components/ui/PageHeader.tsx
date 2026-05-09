import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PageHeader.tsx` — editorial hero header.
 *
 * Pattern from the brand kit:
 *   /00 · WORKSPACE                      [right meta · mono]
 *   Master the *context*.                [88px Cormorant Garamond]
 *   Lede, max-width 580px, ink-dim.      [right actions]
 *
 * Use `<em>...</em>` inside `title` for italic phosphor emphasis.
 */

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly code?: string;
  readonly actions?: ReactNode;
  /** Right column meta strip — typically mono uppercase facts. */
  readonly meta?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, code, actions, meta }: PageHeaderProps) {
  return (
    <header className="mb-14 grid gap-8 lg:grid-cols-[1fr_auto] lg:items-end">
      <div className="flex min-w-0 flex-col">
        {eyebrow !== undefined ? (
          <div className="eyebrow-accent mb-4">{typeof eyebrow === 'string' ? eyebrow : eyebrow}</div>
        ) : null}
        <h1 className="heading-display flex flex-wrap items-baseline gap-x-4 text-[88px] leading-[0.92] text-text-primary">
          {typeof title === 'string' ? <span>{title}</span> : title}
          {code !== undefined ? (
            <span className="font-mono text-[20px] font-normal tracking-[0.04em] text-text-tertiary">{code}</span>
          ) : null}
        </h1>
        {subtitle !== undefined ? (
          <p className="mt-5 max-w-[580px] text-[16px] leading-[1.55] text-text-tertiary">{subtitle}</p>
        ) : null}
      </div>

      {meta !== undefined || actions !== undefined ? (
        <div className="flex flex-col items-start gap-5 lg:items-end">
          {meta !== undefined ? (
            <div className="font-mono text-[10px] leading-[2] uppercase tracking-[0.12em] text-text-tertiary lg:text-right">
              {meta}
            </div>
          ) : null}
          {actions !== undefined ? <div className="flex flex-wrap items-center gap-2.5">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}
