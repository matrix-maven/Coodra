import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Card.tsx` — editorial surface card.
 *
 * Square 1px border on the bg-surface plane (#0d130d). No rounded
 * corners. Tone variants tint the border for danger / warning / info
 * containment. Interactive variant brings the border to phosphor on
 * hover for clickable cards.
 */

export interface CardProps {
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly tone?: 'default' | 'danger' | 'warning' | 'info' | 'subtle';
  readonly className?: string;
  readonly interactive?: boolean;
  /** When true, no padding — caller controls inner spacing. */
  readonly bare?: boolean;
}

const SIZE_PADDING: Record<NonNullable<CardProps['size']>, string> = {
  sm: 'p-5',
  md: 'p-7',
  lg: 'p-8',
};

const TONE_CLASS: Record<NonNullable<CardProps['tone']>, string> = {
  default: 'border-rule bg-bg-surface',
  subtle: 'border-rule bg-bg-elevated',
  danger: 'border-status-error/40 bg-bg-surface',
  warning: 'border-status-warning/40 bg-bg-surface',
  info: 'border-accent/40 bg-bg-surface',
};

export function Card({
  children,
  size = 'md',
  tone = 'default',
  className,
  interactive = false,
  bare = false,
}: CardProps) {
  const interactiveClass = interactive ? 'lift cursor-pointer' : '';
  const padding = bare ? '' : SIZE_PADDING[size];
  return (
    <div
      className={`border ${padding} ${TONE_CLASS[tone]} ${interactiveClass}${className !== undefined ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
