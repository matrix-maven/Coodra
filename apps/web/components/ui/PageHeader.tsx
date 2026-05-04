import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PageHeader.tsx` — canonical page header
 * (M04 Phase 2 UI).
 *
 * One component, one size, one rhythm — replaces the per-page mix of
 * `text-3xl` / `text-4xl` / `text-[56px]` headings that drifted across
 * 17 surfaces. Optional eyebrow (small uppercase context label),
 * monospace `code` slug, and right-aligned action slot.
 *
 * Compose like:
 *
 *   <PageHeader
 *     eyebrow="Pack"
 *     title="Edit"
 *     code={pack.slug}
 *     subtitle="Section-aware editor."
 *     actions={<LinkButton variant="ghost">Back</LinkButton>}
 *   />
 */

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** Small label rendered above the title (uppercase, tracked). */
  readonly eyebrow?: string;
  /** Monospace code suffix appended to the title (e.g. a slug). */
  readonly code?: string;
  /** Right-aligned action slot (buttons, links, dropdowns). */
  readonly actions?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow, code, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          {eyebrow !== undefined ? (
            <span className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-secondary)">
              {eyebrow}
            </span>
          ) : null}
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            {title}
            {code !== undefined ? (
              <span className="ml-3 font-mono text-2xl font-medium normal-case tracking-normal text-(--color-text-code)">
                {code}
              </span>
            ) : null}
          </h1>
        </div>
        {actions !== undefined ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle !== undefined ? <p className="text-sm text-(--color-text-secondary)">{subtitle}</p> : null}
    </header>
  );
}
