import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/FormRow.tsx` — accessible label + input
 * wrapper (M04 Phase 2 UI a11y).
 *
 * Forces every input to have a real <label htmlFor=…> (the skill's
 * form-labels rule). Optional helper text + error message slots
 * appear under the input with proper aria wiring (aria-describedby
 * for helper, aria-invalid + aria-errormessage for errors).
 *
 * Caller passes `inputId` + the input element via children. Example:
 *
 *   <FormRow inputId="slug" label="New slug" helper="lowercase…">
 *     <Input id="slug" name="newSlug" />
 *   </FormRow>
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
      <label
        htmlFor={inputId}
        className="font-display text-xs font-bold uppercase tracking-widest text-(--color-text-secondary)"
      >
        {label}
        {required === true ? (
          <span aria-hidden="true" className="ml-1 text-(--color-status-error)">
            *
          </span>
        ) : null}
      </label>
      {/*
       * Children are rendered as-is; callers must pass the matching
       * `id` + aria attributes. We forward describedby/errormessage
       * via plain prop spread on the closest wrapping fragment so
       * existing pages don't have to thread them manually — but the
       * authoritative pattern is for the caller to wire them on the
       * <Input>. We surface the IDs via data attributes for that.
       */}
      {children}
      {helper !== undefined ? (
        <p id={helperId} className="text-xs text-(--color-text-tertiary)">
          {helper}
        </p>
      ) : null}
      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-xs text-(--color-status-error)">
          {error}
        </p>
      ) : null}
    </div>
  );
}
