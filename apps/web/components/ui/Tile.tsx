import Link from 'next/link';
import type { ReactNode } from 'react';

import { ChevronRightIcon } from './icons';

/**
 * `apps/web/components/ui/Tile.tsx` — KPI tile for dashboards.
 *
 * Refined card with label + large number + optional hint + optional
 * footer. Clickable variant lifts on hover. Restrained color usage —
 * tone tints only the headline number, not the chrome.
 */

export type TileTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface TileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: TileTone;
  readonly href?: string;
  readonly footer?: ReactNode;
}

const TONE_TEXT: Record<TileTone, string> = {
  info: 'text-status-info',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  neutral: 'text-text-primary',
};

export function Tile({ label, value, hint, tone = 'neutral', href, footer }: TileProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">{label}</span>
        {href !== undefined ? (
          <ChevronRightIcon className="h-4 w-4 text-text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-text-secondary" />
        ) : null}
      </div>
      <div className={`font-display text-3xl font-semibold tracking-tight ${TONE_TEXT[tone]}`}>{value}</div>
      {hint !== undefined ? <p className="text-xs text-text-tertiary">{hint}</p> : null}
      {footer !== undefined ? <div className="mt-auto">{footer}</div> : null}
    </>
  );
  const baseClass =
    'group flex flex-col gap-2 rounded-lg border border-border-default bg-bg-surface p-5 shadow-xs transition-all duration-200';
  if (href !== undefined) {
    return (
      <Link href={href as never} className={`${baseClass} cursor-pointer hover:border-border-strong hover:shadow-md`}>
        {inner}
      </Link>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}
