/**
 * `apps/web/components/ui/PageShell.tsx` — outer page container with
 * canonical horizontal gutter + vertical rhythm (M04 Phase 2 UI).
 *
 * Every top-level page composes from PageShell so spacing matches
 * across the workspace + project surfaces. The two variants reflect
 * the IA split:
 *
 *   - `variant="workspace"` — used by /, /init, /sync, /settings/*.
 *     Owns its own outer container (max-w-[1200px] + py-8 + px-8).
 *   - `variant="project"` — used by every /projects/[slug]/* route.
 *     Lives INSIDE the project layout's existing container (which
 *     already supplies the outer chrome via ProjectSubNav + project
 *     header bar), so it only contributes vertical rhythm.
 *
 * Why a single component for both: the outer max-width + horizontal
 * gutter live ONE place. Tweaking the page width touches one file.
 */

import type { ReactNode } from 'react';

export interface PageShellProps {
  readonly children: ReactNode;
  readonly variant?: 'workspace' | 'project';
}

export function PageShell({ children, variant = 'project' }: PageShellProps) {
  if (variant === 'workspace') {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto flex max-w-[1200px] flex-col gap-(--space-section) px-(--space-page-x) py-(--space-section) outline-none"
      >
        {children}
      </main>
    );
  }
  return <div className="flex flex-col gap-(--space-section)">{children}</div>;
}
