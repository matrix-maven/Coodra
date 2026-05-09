import type { ReactNode } from 'react';

import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from './icons';

/**
 * `apps/web/components/ui/Banner.tsx` — editorial inline alert.
 *
 * Square 1px border on bg-surface, leading dot in tone color, body in
 * sentence case. Optional `code` prefix renders a mono chip.
 */

export type BannerKind = 'success' | 'info' | 'warning' | 'error';

const KIND_BORDER: Record<BannerKind, string> = {
  success: 'border-status-success/40',
  info: 'border-accent/40',
  warning: 'border-status-warning/40',
  error: 'border-status-error/40',
};

const KIND_TEXT: Record<BannerKind, string> = {
  success: 'text-status-success',
  info: 'text-accent',
  warning: 'text-status-warning',
  error: 'text-status-error',
};

const KIND_ICON: Record<BannerKind, React.ComponentType<{ className?: string }>> = {
  success: CheckIcon,
  info: InfoIcon,
  warning: AlertTriangleIcon,
  error: XIcon,
};

export interface BannerProps {
  readonly kind: BannerKind;
  readonly children: ReactNode;
  readonly code?: string;
}

export function Banner({ kind, children, code }: BannerProps) {
  const Icon = KIND_ICON[kind];
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-3 border bg-bg-surface px-4 py-3 text-[13px] ${KIND_BORDER[kind]}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${KIND_TEXT[kind]}`} />
      <div className="flex flex-wrap items-baseline gap-2 text-text-primary">
        {code !== undefined ? (
          <span
            className={`border border-rule-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.05em] ${KIND_TEXT[kind]}`}
          >
            {code}
          </span>
        ) : null}
        <span>{children}</span>
      </div>
    </div>
  );
}
