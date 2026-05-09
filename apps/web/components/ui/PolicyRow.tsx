import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/PolicyRow.tsx` — policy-chain row.
 *
 * Five-column grid: verdict · pattern · reason · tools · hits.
 * The header uses tone === 'header' and renders mono uppercase.
 */

export type PolicyVerdictTone = 'allow' | 'deny' | 'warn' | 'header';

export interface PolicyRowProps {
  readonly verdict: string;
  readonly verdictTone: PolicyVerdictTone;
  readonly pattern: ReactNode;
  readonly reason: ReactNode;
  readonly tools: ReactNode;
  readonly hits: ReactNode;
}

const VERDICT_COLOR: Record<PolicyVerdictTone, string> = {
  allow: 'text-accent',
  deny: 'text-status-error',
  warn: 'text-status-warning',
  header: 'text-text-muted',
};

export function PolicyRow({ verdict, verdictTone, pattern, reason, tools, hits }: PolicyRowProps) {
  if (verdictTone === 'header') {
    return (
      <div className="grid grid-cols-[80px_1fr_minmax(160px,_220px)_120px_120px] items-center gap-4 border-b border-rule px-0 py-3 font-mono text-[9px] font-medium uppercase tracking-[0.2em] text-text-muted">
        <div>{verdict}</div>
        <div>{pattern}</div>
        <div>{reason}</div>
        <div>{tools}</div>
        <div className="text-right">{hits}</div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[80px_1fr_minmax(160px,_220px)_120px_120px] items-center gap-4 border border-rule bg-bg-surface px-4 py-4 font-mono text-[11px]">
      <div className={`text-[10px] uppercase tracking-[0.18em] ${VERDICT_COLOR[verdictTone]}`}>{verdict}</div>
      <div className="break-all tracking-[0.02em] text-text-primary">{pattern}</div>
      <div className="font-sans text-[12px] text-text-tertiary">{reason}</div>
      <div className="text-[10px] tracking-[0.06em] text-text-tertiary">{tools}</div>
      <div className="text-right text-text-tertiary">{hits}</div>
    </div>
  );
}
