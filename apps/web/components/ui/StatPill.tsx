import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/StatPill.tsx` — editorial badge / pill.
 *
 * Mono uppercase, narrow padding, optional dot. Tones map to brand
 * kit semantic states: ok (phosphor), warn (crimson), caution (amber),
 * neutral (rule-strong border, dim ink).
 */

export type StatPillTone = 'ok' | 'warn' | 'caution' | 'neutral';

export interface StatPillProps {
  readonly children: ReactNode;
  readonly tone?: StatPillTone;
  readonly dot?: boolean;
  readonly className?: string;
}

const TONE_CLASS: Record<StatPillTone, string> = {
  ok: 'text-accent border-accent',
  warn: 'text-status-error border-status-error',
  caution: 'text-status-warning border-status-warning',
  neutral: 'text-text-tertiary border-rule-strong',
};

export function StatPill({ children, tone = 'neutral', dot = false, className }: StatPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[9px] font-medium uppercase tracking-[0.18em] ${TONE_CLASS[tone]}${
        className !== undefined ? ` ${className}` : ''
      }`}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full bg-current ${tone === 'ok' ? 'shadow-[0_0_6px_currentColor]' : ''}`}
        />
      ) : null}
      <span>{children}</span>
    </span>
  );
}
