import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/FormRow.tsx` — label + input + helper +
 * error wrapper. Sentence-case label.
 */

export interface FormRowProps {
  readonly inputId: string;
  readonly label: string;
  readonly helper?: ReactNode;
  readonly error?: ReactNode;
  readonly required?: boolean;
  readonly children: ReactNode;
}

export function FormRow({ inputId, label, helper, error, required, children }: FormRowProps) {
  const helperId = helper !== undefined ? `${inputId}-helper` : undefined;
  const errorId = error !== undefined ? `${inputId}-error` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
        {label}
        {required === true ? (
          <span aria-hidden="true" className="ml-1 text-status-error">
            *
          </span>
        ) : null}
      </label>
      {children}
      {helper !== undefined ? (
        <p id={helperId} className="text-xs text-text-tertiary">
          {helper}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
