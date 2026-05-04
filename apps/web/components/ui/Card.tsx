import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/Card.tsx` — surface card.
 *
 * Rounded (radius-lg), soft border + xs shadow. Three sizes for
 * padding density. Tone variants tint the border for danger/warning/
 * info containment without being loud.
 */

export interface CardProps {
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly tone?: 'default' | 'danger' | 'warning' | 'info';
  readonly className?: string;
  /** When true the card lifts on hover (used inside lists of clickable cards). */
  readonly interactive?: boolean;
}

const SIZE_PADDING: Record<NonNullable<CardProps['size']>, string> = {
  sm: 'p-4',
  md: 'p-5',
  lg: 'p-6',
};

const TONE_BORDER: Record<NonNullable<CardProps['tone']>, string> = {
  default: 'border-border-default',
  danger: 'border-status-error/30',
  warning: 'border-status-warning/30',
  info: 'border-status-info/30',
};

export function Card({ children, size = 'md', tone = 'default', className, interactive = false }: CardProps) {
  const interactiveClass = interactive ? 'transition-all duration-200 hover:border-border-strong hover:shadow-md' : '';
  return (
    <div
      className={`rounded-lg border bg-bg-surface shadow-xs ${SIZE_PADDING[size]} ${TONE_BORDER[tone]} ${interactiveClass}${
        className !== undefined ? ` ${className}` : ''
      }`}
    >
      {children}
    </div>
  );
}
