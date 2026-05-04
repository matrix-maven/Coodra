import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import Link from 'next/link';

import type { Actor } from '@/lib/auth';
import { clerkAppearance } from '@/lib/clerk-appearance';
import { SoloModeBadge } from './SoloModeBadge';

/**
 * `apps/web/components/HeaderNav.tsx` — workspace-level header
 * (M04 Phase 2 S2c — pivoted from per-route nav to minimal chrome).
 *
 * Pre-pivot Phase 1: the header carried links to every operational
 * route (Runs · Policies · Projects · Packs · Templates · Kill
 * switches). Hub-and-spoke IA flips this — operational routes live
 * under `/projects/[slug]/...`, surfaced via the project-scoped
 * layout's `<ProjectSubNav>`. The workspace header here is
 * intentionally narrow:
 *
 *   - Brand logo (always links to `/`, the project picker).
 *   - "Projects" link (also goes to `/`; redundant with brand but
 *     visible affordance).
 *   - User menu (workspace settings, account, sign out).
 *
 * Project-scoped pages get an additional sub-header from
 * `apps/web/app/projects/[slug]/layout.tsx`.
 */

export interface HeaderNavProps {
  readonly actor: Actor;
}

export function HeaderNav({ actor }: HeaderNavProps) {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-8">
      <div className="flex items-center gap-8">
        <Link
          href="/"
          className="font-display text-base font-black uppercase tracking-wider text-(--color-text-primary)"
        >
          [CTX]<span className="text-(--color-brand)">OS</span>
        </Link>
        <Link
          href="/"
          className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-primary) hover:text-(--color-brand)"
        >
          Projects
        </Link>
        <Link
          href="/init"
          className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-secondary) hover:text-(--color-brand)"
        >
          + New project
        </Link>
        <Link
          href="/settings/workspace"
          className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-secondary) hover:text-(--color-brand)"
        >
          Settings
        </Link>
      </div>

      <div className="flex items-center gap-4">
        {actor.mode === 'solo' ? (
          <SoloModeBadge />
        ) : (
          <>
            <OrganizationSwitcher
              appearance={clerkAppearance}
              hidePersonal
              afterCreateOrganizationUrl="/"
              afterSelectOrganizationUrl="/"
            />
            <UserButton appearance={clerkAppearance} userProfileUrl="/settings/account" />
          </>
        )}
      </div>
    </header>
  );
}
