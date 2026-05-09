import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/EventRow.tsx` — primary audit-trail surface.
 *
 * Mirrors brand-kit `.event` and app `.event` patterns:
 *   [dot] [time · mono] [tool · mono w/ <b> highlight] [duration] [verdict]
 *
 * Verdict tones — accent (ALLOW / OK), error (DENY), neutral (RUNNING),
 * warning (RETRY), muted (manual override).
 */

export type EventVerdict = 'allow' | 'deny' | 'warn' | 'pending' | 'neutral';
export type EventDot = 'green' | 'white' | 'warn' | 'mute';

export interface EventRowProps {
  readonly time: string;
  readonly tool: ReactNode;
  readonly verdict?: string;
  readonly verdictTone?: EventVerdict;
  readonly duration?: string;
  readonly dot?: EventDot;
  readonly className?: string;
}

const DOT_BG: Record<EventDot, string> = {
  green: 'bg-accent',
  white: 'bg-text-primary',
  warn: 'bg-status-error',
  mute: 'bg-text-muted',
};

const VERDICT_COLOR: Record<EventVerdict, string> = {
  allow: 'text-accent',
  deny: 'text-status-error',
  warn: 'text-status-warning',
  pending: 'text-text-tertiary',
  neutral: 'text-text-tertiary',
};

export function EventRow({
  time,
  tool,
  verdict,
  verdictTone = 'allow',
  duration,
  dot = 'green',
  className,
}: EventRowProps) {
  return (
    <div
      className={`grid grid-cols-[14px_100px_1fr_auto_auto] items-center gap-[18px] border border-rule bg-bg-surface px-[18px] py-3.5 font-mono text-[12px] transition-colors duration-200 hover:border-rule-strong${
        className !== undefined ? ` ${className}` : ''
      }`}
    >
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${DOT_BG[dot]}`} />
      <span className="tracking-[0.04em] text-text-tertiary">{time}</span>
      <span className="tracking-[0.02em] text-text-primary">{tool}</span>
      <span className="font-mono text-[10px] tracking-[0.05em] text-text-muted">{duration ?? ''}</span>
      {verdict !== undefined ? (
        <span className={`font-mono text-[10px] uppercase tracking-[0.18em] ${VERDICT_COLOR[verdictTone]}`}>
          {verdict}
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}
