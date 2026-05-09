import type { ReactNode } from 'react';

/**
 * `apps/web/components/StatusChip.tsx` — editorial status badge.
 *
 * Mono uppercase, square 1px border. Phosphor for OK / live, crimson
 * for error / DENY, amber for warning, neutral rule-strong for idle.
 */

export type StatusChipKind = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_CLASSES: Record<StatusChipKind, string> = {
  success: 'text-accent border-accent',
  warning: 'text-status-warning border-status-warning',
  error: 'text-status-error border-status-error',
  info: 'text-accent border-accent',
  neutral: 'text-text-tertiary border-rule-strong',
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
      className={`inline-flex h-5 items-center gap-1.5 border px-2 font-mono text-[9px] font-medium uppercase tracking-[0.18em] ${STATUS_CLASSES[status]}`}
    >
      <span aria-hidden="true" className="h-1 w-1 rounded-full bg-current" />
      {children}
    </span>
  );
}
