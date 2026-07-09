import Link from 'next/link';

import { startServicesAction } from '@/lib/actions/services';

interface TopbarProps {
  readonly crumbPrefix?: string;
  readonly crumb: string;
  /** When set, the trailing accent button uses this label and target href. Default: "coodra start" → POSTs startServicesAction. */
  readonly primaryAction?: { readonly label: string; readonly href: string };
  /**
   * Render the laptop-local "coodra start" button? When omitted, the
   * component infers from `process.env.COODRA_DEPLOYMENT` (Next
   * inlines this at build time for both server and client bundles).
   * Server-component callers can pass the explicit value resolved via
   * `resolveDeploymentMode()` for the local-solo + local-team split.
   *
   * Why infer from env directly instead of importing `deployment-mode`:
   *   `deployment-mode.ts` is marked `'server-only'`. Topbar is reachable
   *   from BOTH server components (most pages) and at least one
   *   `'use client'` component (`app/runs/[id]/live/RunLiveClient.tsx`).
   *   A static import of the server-only module crashes the client
   *   build with `"server-only" ... not supported in pages/ directory`.
   *   Reading `process.env.COODRA_DEPLOYMENT` works in both contexts
   *   because Next's webpack plugin inlines NEXT_PUBLIC_* and other
   *   non-secret env tokens at compile time.
   */
  readonly showLocalStartButton?: boolean;
}

/**
 * web-v2 sticky topbar — works in both server and client component
 * contexts. Trailing buttons branch on `showLocalStartButton`:
 *
 *   - true (local-solo / local-team):
 *       "coodra start" (accent) → POSTs `startServicesAction` to
 *       spawn MCP + Hooks Bridge + (team-only) Sync Daemon on the
 *       local laptop.
 *
 *   - false (team-hosted):
 *       The deployment server has no local daemons to spawn, so the
 *       "coodra start" affordance is hidden — clicking it would
 *       redirect to /forbidden?reason=local_only via the action guard,
 *       which is bad UX. Falls back to the Docs link only unless the
 *       page passes its own primaryAction.
 *
 * The Docs link is constant across modes.
 */
export function Topbar({ crumbPrefix = 'coodra', crumb, primaryAction, showLocalStartButton }: TopbarProps) {
  // Infer from env when not explicitly passed. process.env access here
  // is safe in client bundles because Next.js webpack inlines string
  // literal env reads at compile time. The fallback `team-hosted` is
  // the safer side (hides the button) when the env isn't set.
  const inferredShowStart = showLocalStartButton ?? process.env.COODRA_DEPLOYMENT !== 'team-hosted';
  return (
    <div className="topbar">
      <div className="crumbs">
        <span>{crumbPrefix}</span>
        <span>/</span>
        <strong>{crumb}</strong>
      </div>
      <div className="topbar__search" aria-hidden="true">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <span>Search runs, packs, decisions…</span>
        <span className="topbar__search-key">⌘K</span>
      </div>
      <Link
        href="https://matrix-maven.github.io/Coodra/"
        target="_blank"
        rel="noopener noreferrer"
        className="topbar__btn"
      >
        Docs
      </Link>
      {primaryAction !== undefined ? (
        <Link href={primaryAction.href} className="topbar__btn topbar__btn--accent">
          {primaryAction.label}
        </Link>
      ) : inferredShowStart ? (
        <form action={startServicesAction} style={{ display: 'inline' }}>
          <button className="topbar__btn topbar__btn--accent" type="submit">
            coodra start
          </button>
        </form>
      ) : null}
    </div>
  );
}
