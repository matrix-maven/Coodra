import type { ReactNode } from 'react';

/**
 * `apps/web/components/RiskBadge.tsx` — editorial risk-level pill.
 *
 * Mono uppercase, square 1px border. Tones map to the brand kit:
 * low → phosphor, medium → amber, high → crimson.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_CLASSES: Record<RiskLevel, string> = {
  low: 'text-accent border-accent',
  medium: 'text-status-warning border-status-warning',
  high: 'text-status-error border-status-error',
};

export interface RiskBadgeProps {
  readonly level: RiskLevel;
  readonly children: ReactNode;
}

export function RiskBadge({ level, children }: RiskBadgeProps) {
  return (
    <span
      data-testid="risk-badge"
      data-level={level}
      className={`inline-flex h-5 items-center gap-1.5 border px-2 font-mono text-[9px] font-medium uppercase tracking-[0.18em] ${RISK_CLASSES[level]}`}
    >
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />
      {children}
    </span>
  );
}
