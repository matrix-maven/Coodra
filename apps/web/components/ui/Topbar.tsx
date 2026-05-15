import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Topbar.tsx` — sticky editorial top bar.
 *
 * Pattern: breadcrumbs (mono, dim, with phosphor active leaf) on the
 * left; ⌘K search affordance in the center; trailing actions on the
 * right (Docs link + `coodra start` accent button by default).
 *
 * Sticky with a subtle backdrop blur so screen content reads through.
 */

export interface TopbarProps {
  readonly crumbs: ReadonlyArray<{ readonly label: string; readonly href?: string }>;
  readonly actions?: ReactNode;
  /** Optional search slot — caller wires the input + ⌘K handler. */
  readonly search?: ReactNode;
}

export function Topbar({ crumbs, actions, search }: TopbarProps) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-6 border-b border-rule bg-bg-base/92 px-12 py-[18px] backdrop-blur">
      <nav
        aria-label="Breadcrumb"
        className="flex flex-1 items-center font-mono text-[11px] tracking-[0.08em] text-text-tertiary"
      >
        {crumbs.map((crumb, idx) => {
          const isLast = idx === crumbs.length - 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional and may repeat labels
            <span key={`${crumb.label}-${idx}`} className="flex items-center">
              {idx > 0 ? <span className="mx-2 text-text-muted">/</span> : null}
              {isLast || crumb.href === undefined ? (
                <strong className="font-medium text-text-primary">{crumb.label}</strong>
              ) : (
                <Link href={crumb.href as never} className="transition-colors hover:text-text-primary">
                  {crumb.label}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      {search !== undefined ? <div className="flex-shrink-0">{search}</div> : null}

      {actions !== undefined ? <div className="flex flex-shrink-0 items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}
