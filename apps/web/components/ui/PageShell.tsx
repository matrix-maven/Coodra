import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PageShell.tsx` — page content wrapper.
 *
 * Workspace pages (`/`, `/init`, `/sync`, `/settings/workspace`) own
 * their own outer container because the root layout doesn't render
 * the project topbar for them. Project pages live inside the
 * `/projects/[slug]/layout.tsx` <main> already so the project variant
 * just provides vertical rhythm.
 */

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
        className="mx-auto flex w-full max-w-[1280px] flex-col gap-(--space-section) px-(--space-page-x) py-(--space-page-y) outline-none"
      >
        {children}
      </main>
    );
  }
  return <div className="flex flex-col gap-(--space-section)">{children}</div>;
}
