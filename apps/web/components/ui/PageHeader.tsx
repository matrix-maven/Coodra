import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PageHeader.tsx` — refined page header.
 *
 * Sentence-case title (no more uppercase tracking). Optional eyebrow
 * (small muted label above title) and right-aligned actions slot.
 */

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly eyebrow?: string;
  readonly code?: string;
  readonly actions?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, code, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-1.5">
      {eyebrow !== undefined ? <span className="text-xs font-medium text-text-tertiary">{eyebrow}</span> : null}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text-primary">
            {title}
            {code !== undefined ? (
              <span className="ml-3 font-mono text-xl font-normal text-text-code">{code}</span>
            ) : null}
          </h1>
          {subtitle !== undefined ? <p className="text-sm text-text-secondary">{subtitle}</p> : null}
        </div>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
