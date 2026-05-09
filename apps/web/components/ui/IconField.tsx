import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/IconField.tsx` — premium form-field row.
 *
 * Tone-tinted icon tile on the left, label + input + helper on the
 * right. Used by /init and /kill-switches forms to give every field
 * a distinct visual identity. Server-renderable; the input element
 * is supplied as children so callers stay in control.
 */

export type IconFieldTone = 'sky' | 'violet' | 'emerald' | 'amber' | 'rose' | 'neutral';

const TONE_BG: Record<IconFieldTone, string> = {
  sky: 'bg-accent-sky-soft text-accent-sky',
  violet: 'bg-accent-violet-soft text-accent-violet',
  emerald: 'bg-status-success-soft text-status-success',
  amber: 'bg-accent-amber-soft text-accent-amber',
  rose: 'bg-accent-rose-soft text-accent-rose',
  neutral: 'bg-bg-elevated text-text-secondary',
};

export interface IconFieldProps {
  readonly icon: ReactNode;
  readonly tone?: IconFieldTone;
  readonly label: string;
  readonly required?: boolean;
  readonly helper?: ReactNode;
  readonly children: ReactNode;
}

export function IconField({ icon, tone = 'neutral', label, required, helper, children }: IconFieldProps) {
  return (
    <div className="flex gap-4">
      <span
        aria-hidden="true"
        className={`mt-7 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONE_BG[tone]}`}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[13px] font-medium text-text-primary">
          {label}
          {required === true ? (
            <span aria-hidden="true" className="ml-1 text-status-error">
              *
            </span>
          ) : null}
        </span>
        {children}
        {helper !== undefined ? <p className="text-[11.5px] leading-relaxed text-text-tertiary">{helper}</p> : null}
      </div>
    </div>
  );
}
