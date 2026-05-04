import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/**
 * `apps/web/components/ui/Input.tsx` — text inputs (M04 Phase 2 UI).
 *
 * Three primitives, one shape:
 *   - <Input>     native text/email/number input.
 *   - <Textarea>  resizable native textarea.
 *   - <Select>    native select (no JS, no popover).
 *
 * All three accept `invalid` to switch border to status-error and
 * mono to render in JetBrains Mono (slugs / paths). Height + padding
 * pinned via the --input-height token + --space-3 token.
 */

const BASE =
  'block w-full border bg-(--color-bg-base) px-3 text-sm text-(--color-text-primary) transition-colors duration-200 placeholder:text-(--color-text-tertiary)';
const HEIGHT = 'h-(--input-height)';
const BORDER_DEFAULT = 'border-(--color-border-default) focus:border-(--color-brand)';
const BORDER_INVALID = 'border-(--color-status-error) focus:border-(--color-status-error)';

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
  // Textarea overrides the fixed input height with `min-h-32` and
  // honors the className override (most callers want a tall editor).
  return (
    <textarea
      {...rest}
      className={[
        BASE,
        'min-h-32 resize-y py-3',
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
    <select {...rest} className={inputClass(invalid, mono, className)}>
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
      className={`h-4 w-4 cursor-pointer accent-(--color-brand)${className !== undefined ? ` ${className}` : ''}`}
    />
  );
}
