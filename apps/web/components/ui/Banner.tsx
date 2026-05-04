import type { ReactNode } from 'react';

import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from './icons';

/**
 * `apps/web/components/ui/Banner.tsx` — inline alert / status banner
 * (M04 Phase 2 UI).
 *
 * Replaces the 6+ hand-rolled <div className="border-l-4 …"> blocks
 * scattered across pages. One shape, four kinds:
 *
 *   success — green, CheckIcon       (operation completed)
 *   info    — blue,  InfoIcon        (heads-up / soft-failure)
 *   warning — amber, AlertTriangle   (degraded / sentinel)
 *   error   — red,   XIcon           (action refused / parse failed)
 *
 * Optional `code` (a short `error_code_token`) renders in mono before
 * the message — matches the Server Action redirect contract that
 * encodes structured error codes in the querystring.
 */

export type BannerKind = 'success' | 'info' | 'warning' | 'error';

const KIND_BORDER: Record<BannerKind, string> = {
  success: 'border-(--color-status-success) bg-(--color-status-success)/10',
  info: 'border-(--color-status-info) bg-(--color-status-info)/10',
  warning: 'border-(--color-status-warning) bg-(--color-status-warning)/10',
  error: 'border-(--color-status-error) bg-(--color-status-error)/10',
};

const KIND_TEXT: Record<BannerKind, string> = {
  success: 'text-(--color-status-success)',
  info: 'text-(--color-status-info)',
  warning: 'text-(--color-status-warning)',
  error: 'text-(--color-status-error)',
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
  /** Short error code rendered in mono before the message. */
  readonly code?: string;
}

export function Banner({ kind, children, code }: BannerProps) {
  const Icon = KIND_ICON[kind];
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-3 border-l-4 px-4 py-3 text-sm ${KIND_BORDER[kind]}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${KIND_TEXT[kind]}`} />
      <div className="flex flex-wrap items-baseline gap-2 text-(--color-text-primary)">
        {code !== undefined ? <span className={`font-mono text-xs ${KIND_TEXT[kind]}`}>{code}</span> : null}
        <span>{children}</span>
      </div>
    </div>
  );
}
