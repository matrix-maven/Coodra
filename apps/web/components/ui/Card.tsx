import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Card.tsx` — surface card with consistent
 * border + padding (M04 Phase 2 UI).
 *
 * Replaces the per-page mix of `border border-(--color-border-subtle)
 * bg-(--color-bg-surface) p-{4,6,8}`. Three sizes only:
 *
 *   - `sm`   → p-4   (compact callouts, sidebars)
 *   - `md`   → p-6   (default — most content cards)
 *   - `lg`   → p-8   (hero sections, large empty states)
 *
 * Optional `tone` switches the border color — used for destructive /
 * error containment (Delete project section, parse-error banners).
 */

export interface CardProps {
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly tone?: 'default' | 'danger' | 'warning' | 'info';
  readonly className?: string;
}

const SIZE_PADDING: Record<NonNullable<CardProps['size']>, string> = {
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

const TONE_BORDER: Record<NonNullable<CardProps['tone']>, string> = {
  default: 'border-(--color-border-subtle)',
  danger: 'border-(--color-status-error)/40',
  warning: 'border-(--color-status-warning)/40',
  info: 'border-(--color-status-info)/40',
};

export function Card({ children, size = 'md', tone = 'default', className }: CardProps) {
  return (
    <div
      className={`border bg-(--color-bg-surface) ${SIZE_PADDING[size]} ${TONE_BORDER[tone]}${
        className !== undefined ? ` ${className}` : ''
      }`}
    >
      {children}
    </div>
  );
}
