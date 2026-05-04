import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Tile.tsx` — KPI tile (M04 Phase 2 UI).
 *
 * One canonical implementation of the "label + big number + footer
 * caret" tile. Replaces the 4 hand-rolled variants across project
 * home, doctor tile, sync, and settings overview.
 *
 * Renders as a <Link> when `href` is set (clickable card with hover
 * border) or a plain <div> otherwise.
 */

export type TileTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface TileProps {
  readonly label: string;
  readonly value: ReactNode;
  /** Optional sub-line (caption / context under the number). */
  readonly hint?: ReactNode;
  readonly tone?: TileTone;
  readonly href?: string;
  /** Extra trailing content (status chip, mini-strip). */
  readonly footer?: ReactNode;
}

const TONE_TEXT: Record<TileTone, string> = {
  info: 'text-(--color-status-info)',
  success: 'text-(--color-status-success)',
  warning: 'text-(--color-status-warning)',
  error: 'text-(--color-status-error)',
  neutral: 'text-(--color-text-primary)',
};

export function Tile({ label, value, hint, tone = 'neutral', href, footer }: TileProps) {
  const inner = (
    <>
      <div className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-secondary)">
        {label}
      </div>
      <div className={`font-display text-5xl font-black leading-none ${TONE_TEXT[tone]}`}>{value}</div>
      {hint !== undefined ? <p className="text-xs text-(--color-text-tertiary)">{hint}</p> : null}
      {footer !== undefined ? <div className="mt-auto">{footer}</div> : null}
    </>
  );
  const baseClass =
    'group flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 transition-colors duration-200';
  if (href !== undefined) {
    return (
      <Link
        href={href as never}
        className={`${baseClass} cursor-pointer hover:border-(--color-brand) hover:bg-(--color-bg-elevated)`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}
