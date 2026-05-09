import Link from 'next/link';

import { startServicesAction } from '@/lib/actions/services';

interface TopbarProps {
  readonly crumbPrefix?: string;
  readonly crumb: string;
  /** When set, the trailing accent button uses this label and target href. Default: "contextos start" → POSTs startServicesAction. */
  readonly primaryAction?: { readonly label: string; readonly href: string };
}

/**
 * web-v2 sticky topbar.
 *
 * Trailing buttons:
 *   - Docs → opens the project README on github.com (placeholder until
 *     /docs ships).
 *   - "contextos start" (accent) → POSTs `startServicesAction` to spin
 *     up MCP + Hooks Bridge + (team-only) Sync Daemon. Redirects to
 *     /workspace with a status banner. The button is rendered as
 *     `<button form="topbar-start-form">` so the SR experience matches
 *     the visual one even though the form lives outside the topbar
 *     flex.
 */
export function Topbar({ crumbPrefix = 'contextos', crumb, primaryAction }: TopbarProps) {
  return (
    <div className="topbar">
      <div className="crumbs">
        <span>{crumbPrefix}</span>
        <span>/</span>
        <strong>{crumb}</strong>
      </div>
      <div className="topbar__search" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="11" cy="11" r="7" />
          <line x1="16.5" y1="16.5" x2="21" y2="21" />
        </svg>
        <span>Search runs, packs, decisions…</span>
        <span className="topbar__search-key">⌘K</span>
      </div>
      <Link
        href="https://github.com/anthropics/claude-code"
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
      ) : (
        <form action={startServicesAction} style={{ display: 'inline' }}>
          <button className="topbar__btn topbar__btn--accent" type="submit">
            contextos start
          </button>
        </form>
      )}
    </div>
  );
}
