import type { ReactNode } from 'react';

import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from './icons';

/**
 * `apps/web/components/ui/Banner.tsx` — inline alert.
 *
 * Soft tinted bg + matching icon + sentence-case body. Replaces the
 * old border-l-4 strip with a more refined rounded card.
 */

export type BannerKind = 'success' | 'info' | 'warning' | 'error';

const KIND_BG: Record<BannerKind, string> = {
  success: 'bg-status-success-soft border-status-success/30',
  info: 'bg-status-info-soft border-status-info/30',
  warning: 'bg-status-warning-soft border-status-warning/30',
  error: 'bg-status-error-soft border-status-error/30',
};

const KIND_TEXT: Record<BannerKind, string> = {
  success: 'text-status-success',
  info: 'text-status-info',
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
      className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${KIND_BG[kind]}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${KIND_TEXT[kind]}`} />
      <div className="flex flex-wrap items-baseline gap-2 text-text-primary">
        {code !== undefined ? (
          <span className={`rounded bg-bg-surface px-1.5 py-0.5 font-mono text-xs ${KIND_TEXT[kind]}`}>{code}</span>
        ) : null}
        <span>{children}</span>
      </div>
    </div>
  );
}
