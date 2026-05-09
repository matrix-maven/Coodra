import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Tile.tsx` — editorial KPI tile / stat cell.
 *
 * Pattern: mono uppercase label, large serif hero number (with optional
 * italic phosphor emphasis via `<em>` in `value`), mono delta hint.
 *
 * Two layouts:
 *   - default: bordered card on bg-surface
 *   - bare: borderless cell for inline `.stats` rows (use `bare`)
 */

export type TileTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface TileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly tone?: TileTone;
  readonly href?: string;
  readonly footer?: ReactNode;
  readonly icon?: ReactNode;
  readonly trend?: ReactNode;
  /** When true, no border / padding; for inline `.stats` row cells. */
  readonly bare?: boolean;
}

const TONE_HINT: Record<TileTone, string> = {
  info: 'text-accent',
  success: 'text-status-success',
  warning: 'text-status-warning',
  error: 'text-status-error',
  neutral: 'text-text-tertiary',
};

export function Tile({ label, value, hint, tone = 'neutral', href, footer, icon, trend, bare = false }: TileProps) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {icon !== undefined ? <span className="text-text-tertiary">{icon}</span> : null}
          <span className="eyebrow text-text-tertiary">{label}</span>
        </div>
      </div>

      <div className="num-display text-[64px] leading-[0.95] text-text-primary">{value}</div>

      {hint !== undefined ? (
        <div className={`font-mono text-[10px] tracking-[0.08em] ${TONE_HINT[tone]}`}>
          {hint}
          {trend !== undefined ? <span className="ml-2 text-text-tertiary">{trend}</span> : null}
        </div>
      ) : null}

      {footer !== undefined ? <div className="mt-auto pt-2">{footer}</div> : null}
    </>
  );

  const baseClass = bare
    ? 'flex flex-col gap-4 px-7 py-8'
    : 'flex flex-col gap-4 border border-rule bg-bg-surface px-7 py-7';
  const interactive = href !== undefined ? 'transition-colors duration-200 hover:border-accent' : '';

  if (href !== undefined) {
    return (
      <Link href={href as never} className={`${baseClass} ${interactive}`}>
        {inner}
      </Link>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}
