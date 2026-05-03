import type { ReactNode } from 'react';

/**
 * Risk-level badge per `docs/feature-packs/04-web-app/wireframes/03-component-inventory.md`.
 * Same dimensions as StatusChip but uses the brand's risk palette.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_CLASSES: Record<RiskLevel, string> = {
  low: 'bg-(--color-risk-low)/10 border-l-2 border-l-(--color-risk-low) text-(--color-text-primary)',
  medium: 'bg-(--color-risk-medium)/10 border-l-2 border-l-(--color-risk-medium) text-(--color-text-primary)',
  high: 'bg-(--color-risk-high)/10 border-l-2 border-l-(--color-risk-high) text-(--color-text-primary)',
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
      className={`inline-flex h-6 items-center px-2 font-mono text-[11px] font-medium uppercase ${RISK_CLASSES[level]}`}
    >
      {children}
    </span>
  );
}
