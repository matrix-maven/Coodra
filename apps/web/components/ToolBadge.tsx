/**
 * `apps/web/components/ToolBadge.tsx` — editorial tool-name chip.
 *
 * Mono lowercase (matches brand kit `.event__tool` style). Used in
 * run rows, audit tables, and the live tail.
 */

export interface ToolBadgeProps {
  readonly name: string;
}

export function ToolBadge({ name }: ToolBadgeProps) {
  return (
    <span
      data-testid="tool-badge"
      data-tool={name}
      className="inline-flex h-5 items-center border border-rule-strong bg-bg-elevated px-2 font-mono text-[10px] tracking-[0.04em] text-text-primary"
    >
      {name}
    </span>
  );
}
