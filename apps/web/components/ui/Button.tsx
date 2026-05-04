import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `apps/web/components/ui/Button.tsx` — canonical button (M04 Phase 2 UI).
 *
 * Three components in one file:
 *
 *   - `<Button>`      — native <button>, supports type="submit" for forms.
 *   - `<LinkButton>`  — same look, renders <Link> for client-side nav.
 *   - `<IconButton>`  — square icon-only, requires aria-label.
 *
 * Variants align with the brand palette + the data-dense dashboard
 * style spec:
 *
 *   primary     — solid brand blue, white text. CTA / submit.
 *   secondary   — subtle border, hover gains brand border + text.
 *   ghost       — no border, hover gains brand text. Inline links.
 *   destructive — red border + red text. Delete / Stop.
 *
 * Sizes: `sm` (28px height, dense tables) and `md` (40px, default).
 * Both meet the touch-target rule when paired with adequate hit slop.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-(--color-brand) text-white hover:bg-(--color-brand-hover) border border-(--color-brand)',
  secondary:
    'bg-(--color-bg-base) text-(--color-text-primary) border border-(--color-border-default) hover:border-(--color-brand) hover:text-(--color-brand)',
  ghost: 'bg-transparent text-(--color-text-secondary) hover:text-(--color-brand) border border-transparent',
  destructive:
    'bg-(--color-bg-base) text-(--color-status-error) border border-(--color-status-error)/40 hover:bg-(--color-status-error)/10',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-3 text-[10px]',
  md: 'h-10 px-4 text-xs',
};

const BASE_CLASS =
  'inline-flex items-center justify-center gap-2 font-display font-bold uppercase tracking-widest cursor-pointer transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50';

function classFor(variant: ButtonVariant, size: ButtonSize, extra?: string): string {
  return `${BASE_CLASS} ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]}${extra !== undefined ? ` ${extra}` : ''}`;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly leftIcon?: ReactNode;
  readonly rightIcon?: ReactNode;
  readonly children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={classFor(variant, size, className)} {...rest}>
      {leftIcon}
      <span>{children}</span>
      {rightIcon}
    </button>
  );
}

export interface LinkButtonProps {
  readonly href: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly leftIcon?: ReactNode;
  readonly rightIcon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly download?: boolean;
  readonly target?: string;
  readonly rel?: string;
}

export function LinkButton({
  href,
  variant = 'secondary',
  size = 'md',
  leftIcon,
  rightIcon,
  children,
  className,
  download,
  target,
  rel,
}: LinkButtonProps) {
  // External / file-download links bypass next/link to keep the
  // download attribute behavior + avoid the SPA navigation guard.
  if (download === true || target !== undefined) {
    return (
      <a
        href={href}
        download={download}
        target={target}
        rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
        className={classFor(variant, size, className)}
      >
        {leftIcon}
        <span>{children}</span>
        {rightIcon}
      </a>
    );
  }
  return (
    <Link href={href as never} className={classFor(variant, size, className)}>
      {leftIcon}
      <span>{children}</span>
      {rightIcon}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'leftIcon' | 'rightIcon' | 'children'> {
  readonly 'aria-label': string;
  readonly icon: ReactNode;
}

export function IconButton({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const sizeClass = size === 'sm' ? 'h-7 w-7' : 'h-10 w-10';
  return (
    <button
      type={type}
      className={`${BASE_CLASS} ${sizeClass} ${VARIANT_CLASS[variant]}${className !== undefined ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon}
    </button>
  );
}
