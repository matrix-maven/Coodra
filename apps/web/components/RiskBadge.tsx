import type { ReactNode } from 'react';

/**
 * `apps/web/components/RiskBadge.tsx` — risk-level pill.
 *
 * Same dimensions as StatusChip, uses the brand risk palette
 * (low/medium/high → success/warning/error tones).
 */

export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_CLASSES: Record<RiskLevel, string> = {
  low: 'bg-status-success-soft text-status-success ring-1 ring-status-success/20',
  medium: 'bg-status-warning-soft text-status-warning ring-1 ring-status-warning/20',
  high: 'bg-status-error-soft text-status-error ring-1 ring-status-error/20',
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
      className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${RISK_CLASSES[level]}`}
    >
      {children}
    </span>
  );
}
