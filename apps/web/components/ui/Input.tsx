import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * `apps/web/components/ui/Input.tsx` — editorial form controls.
 *
 * Square 1px border on the bg-base plane (so they read as inset
 * machine surfaces against bg-surface cards). Mono input by default
 * — these capture paths, slugs, JQL — flip to sans only via `sans`.
 * `invalid` switches the border to crimson.
 */

const BASE =
  'block w-full border bg-bg-base px-3.5 text-text-primary transition-colors duration-150 placeholder:text-text-muted focus-visible:outline-none';
const HEIGHT = 'h-(--input-height)';
const BORDER_DEFAULT = 'border-rule-strong hover:border-text-tertiary focus:border-accent';
const BORDER_INVALID = 'border-status-error focus:border-status-error';
const TYPE_MONO = 'font-mono text-[12px] tracking-[0.04em]';
const TYPE_SANS = 'font-sans text-[13px]';

function inputClass(invalid: boolean | undefined, sans: boolean | undefined, extra?: string): string {
  return [
    BASE,
    HEIGHT,
    invalid === true ? BORDER_INVALID : BORDER_DEFAULT,
    sans === true ? TYPE_SANS : TYPE_MONO,
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  readonly invalid?: boolean;
  /** When true, render as `sans` (Inter Tight) instead of mono. */
  readonly sans?: boolean;
  /** @deprecated mono is the default — use `sans` to flip. */
  readonly mono?: boolean;
  readonly className?: string;
}

export function Input({ invalid, sans, mono, className, ...rest }: InputProps) {
  // Honour legacy `mono={true}` calls — they retain the default mono path.
  const useSans = sans === true && mono !== true;
  return <input {...rest} className={inputClass(invalid, useSans, className)} />;
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  readonly invalid?: boolean;
  readonly sans?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
}

export function Textarea({ invalid, sans, mono, className, ...rest }: TextareaProps) {
  const useSans = sans === true && mono !== true;
  return (
    <textarea
      {...rest}
      className={[
        BASE,
        'min-h-32 resize-y py-3 leading-[1.5]',
        invalid === true ? BORDER_INVALID : BORDER_DEFAULT,
        useSans ? TYPE_SANS : TYPE_MONO,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> {
  readonly invalid?: boolean;
  readonly sans?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Select({ invalid, sans, mono, className, children, ...rest }: SelectProps) {
  const useSans = sans === true && mono !== true;
  return (
    <select {...rest} className={`${inputClass(invalid, useSans, className)} appearance-none pr-8`}>
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  readonly className?: string;
}

export function Checkbox({ className, ...rest }: CheckboxProps) {
  return (
    <input
      {...rest}
      type="checkbox"
      className={`h-4 w-4 cursor-pointer border border-rule-strong bg-bg-base accent-accent${
        className !== undefined ? ` ${className}` : ''
      }`}
    />
  );
}
