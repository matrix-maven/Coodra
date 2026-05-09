import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PageShell.tsx` — page content wrapper.
 *
 * Workspace pages own their outer container; project pages live
 * inside the project layout. Both share the section rhythm and
 * generous bottom padding so content doesn't crowd the viewport
 * floor.
 */

export interface PageShellProps {
  readonly children: ReactNode;
  readonly variant?: 'workspace' | 'project';
  /** When true, content stretches edge-to-edge (used by full-bleed log/graph views). */
  readonly fullBleed?: boolean;
}

export function PageShell({ children, variant = 'project', fullBleed = false }: PageShellProps) {
  if (variant === 'workspace') {
    return (
      <main
        id="main"
        tabIndex={-1}
        className={`mx-auto flex w-full ${
          fullBleed ? '' : 'max-w-(--content-max)'
        } flex-col gap-(--space-section) px-(--space-page-x) py-(--space-page-y) pb-20 outline-none`}
      >
        {children}
      </main>
    );
  }
  return <div className="flex flex-col gap-(--space-section) pb-12">{children}</div>;
}
