import type { ReactNode } from 'react';

/**
 * `apps/web/components/StatusChip.tsx` — small status pill.
 *
 * Refined for the new design: rounded pill, soft tinted bg, matching
 * text color. Sentence-case (no more uppercase). Used in run-status,
 * pack active/inactive, decision allow/ask/deny, etc.
 */

export type StatusChipKind = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_CLASSES: Record<StatusChipKind, string> = {
  success: 'bg-status-success-soft text-status-success ring-1 ring-status-success/20',
  warning: 'bg-status-warning-soft text-status-warning ring-1 ring-status-warning/20',
  error: 'bg-status-error-soft text-status-error ring-1 ring-status-error/20',
  info: 'bg-status-info-soft text-status-info ring-1 ring-status-info/20',
  neutral: 'bg-bg-elevated text-text-secondary ring-1 ring-border-default',
};

export interface StatusChipProps {
  readonly status: StatusChipKind;
  readonly children: ReactNode;
}

export function StatusChip({ status, children }: StatusChipProps) {
  return (
    <span
      data-testid="status-chip"
      data-status={status}
      className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium ${STATUS_CLASSES[status]}`}
    >
      {children}
    </span>
  );
}
