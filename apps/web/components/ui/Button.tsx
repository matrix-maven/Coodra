import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `apps/web/components/ui/Button.tsx` — refined button system.
 *
 * Three components share one shape:
 *   <Button>      native <button>; honors type="submit".
 *   <LinkButton>  same look, renders <Link> (or <a download> when needed).
 *   <IconButton>  square icon-only with required aria-label.
 *
 * Variants: primary | secondary | ghost | destructive | outline.
 * Sizes:    sm | md (default).
 *
 * Sentence-case labels (no more uppercase tracking everywhere).
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white border border-brand hover:bg-brand-hover hover:border-brand-hover shadow-xs',
  secondary:
    'bg-bg-surface text-text-primary border border-border-default hover:bg-bg-elevated hover:border-border-strong shadow-xs',
  ghost: 'bg-transparent text-text-secondary border border-transparent hover:bg-bg-elevated hover:text-text-primary',
  destructive:
    'bg-bg-surface text-status-error border border-status-error/30 hover:bg-status-error/10 hover:border-status-error/50',
  outline: 'bg-transparent text-brand border border-brand/40 hover:bg-brand-soft hover:border-brand',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-(--button-height-sm) px-3 text-xs gap-1.5',
  md: 'h-(--button-height) px-4 text-sm gap-2',
};

const BASE_CLASS =
  'inline-flex items-center justify-center rounded-md font-medium transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none';

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
  const sizeClass = size === 'sm' ? 'h-7 w-7' : 'h-9 w-9';
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
