import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * `apps/web/components/ui/Button.tsx` — editorial button system.
 *
 * Three components share one shape:
 *   <Button>      native <button>; honors type="submit".
 *   <LinkButton>  same look, renders <Link> (or <a download>).
 *   <IconButton>  square icon-only with required aria-label.
 *
 * Variants: primary | secondary | ghost | destructive | outline.
 * Sizes:    sm | md (default).
 *
 * Buttons are mono uppercase, tracked wide, square borders. Primary
 * uses phosphor (--color-accent) on the dark plane. Secondary is a
 * 1px ink border on transparent. Ghost is rule-strong on dim ink.
 * Destructive borrows the crimson border + soft fill.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'outline';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-bg-base border border-accent hover:bg-text-primary hover:border-text-primary hover:text-bg-base',
  secondary: 'bg-transparent text-text-primary border border-text-primary hover:bg-text-primary hover:text-bg-base',
  ghost:
    'bg-transparent text-text-tertiary border border-rule-strong hover:text-text-primary hover:border-text-primary',
  destructive: 'bg-transparent text-status-error border border-status-error hover:bg-status-error-soft',
  outline: 'bg-transparent text-text-primary border border-rule-strong hover:border-text-primary',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-(--button-height-sm) px-3 text-[9px] tracking-[0.16em] gap-1.5',
  md: 'h-(--button-height) px-5 text-[10px] tracking-[0.18em] gap-2',
};

const BASE_CLASS =
  'inline-flex items-center justify-center font-mono font-medium uppercase transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none whitespace-nowrap';

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
  const sizeClass = size === 'sm' ? 'h-7 w-7' : 'h-(--button-height) w-(--button-height)';
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
