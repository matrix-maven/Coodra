import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * `apps/web/components/ui/Input.tsx` — refined form controls.
 *
 * Rounded (radius-md), soft border, subtle hover, brand-tinted focus.
 * `mono` toggles JetBrains Mono for slug/path inputs. `invalid`
 * switches the border to status-error.
 */

const BASE =
  'block w-full rounded-md border bg-bg-surface px-3 text-sm text-text-primary transition-colors duration-150 placeholder:text-text-muted focus-visible:outline-none';
const HEIGHT = 'h-(--input-height)';
const BORDER_DEFAULT =
  'border-border-default hover:border-border-strong focus:border-brand focus:shadow-[0_0_0_3px_rgba(37,99,235,0.18)]';
const BORDER_INVALID = 'border-status-error focus:border-status-error focus:shadow-[0_0_0_3px_rgba(239,68,68,0.18)]';

function inputClass(invalid: boolean | undefined, mono: boolean | undefined, extra?: string): string {
  return [
    BASE,
    HEIGHT,
    invalid === true ? BORDER_INVALID : BORDER_DEFAULT,
    mono === true ? 'font-mono' : '',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  readonly invalid?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
}

export function Input({ invalid, mono, className, ...rest }: InputProps) {
  return <input {...rest} className={inputClass(invalid, mono, className)} />;
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  readonly invalid?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
}

export function Textarea({ invalid, mono, className, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      className={[
        BASE,
        'min-h-32 resize-y py-3 leading-6',
        invalid === true ? BORDER_INVALID : BORDER_DEFAULT,
        mono === true ? 'font-mono' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'children'> {
  readonly invalid?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Select({ invalid, mono, className, children, ...rest }: SelectProps) {
  return (
    <select {...rest} className={`${inputClass(invalid, mono, className)} appearance-none pr-8`}>
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
      className={`h-4 w-4 cursor-pointer rounded border-border-default accent-brand${
        className !== undefined ? ` ${className}` : ''
      }`}
    />
  );
}
