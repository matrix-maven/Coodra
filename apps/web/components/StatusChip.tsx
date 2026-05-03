import type { ReactNode } from 'react';

/**
 * Small inline status chip per `docs/feature-packs/04-web-app/wireframes/03-component-inventory.md`.
 * Used in tile values, table cells, and inline run status. Tokens drive everything; no inline hex.
 */

export type StatusChipKind = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUS_CLASSES: Record<StatusChipKind, string> = {
  success: 'bg-(--color-status-success)/10 border-l-2 border-l-(--color-status-success) text-(--color-text-primary)',
  warning: 'bg-(--color-status-warning)/10 border-l-2 border-l-(--color-status-warning) text-(--color-text-primary)',
  error: 'bg-(--color-status-error)/10 border-l-2 border-l-(--color-status-error) text-(--color-text-primary)',
  info: 'bg-(--color-status-info)/10 border-l-2 border-l-(--color-status-info) text-(--color-text-primary)',
  neutral: 'bg-(--color-status-neutral)/10 border-l-2 border-l-(--color-status-neutral) text-(--color-text-primary)',
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
      className={`inline-flex h-6 items-center px-2 font-mono text-[11px] font-medium uppercase ${STATUS_CLASSES[status]}`}
    >
      {children}
    </span>
  );
}
