import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/DataTable.tsx` — editorial table primitive.
 *
 * Header row uses mono uppercase eyebrow tracking. Cells respect the
 * editorial 18px row padding. Hover lifts the row to a faint phosphor
 * tint. Outer container is square 1px border on bg-surface.
 */

export interface TableProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Table({ children, className }: TableProps) {
  return (
    <div className="border border-rule bg-bg-surface">
      <div className="overflow-x-auto">
        <table className={`w-full text-[13px]${className !== undefined ? ` ${className}` : ''}`}>{children}</table>
      </div>
    </div>
  );
}

export function THead({ children }: { readonly children: ReactNode }) {
  return <thead>{children}</thead>;
}

export function TBody({ children }: { readonly children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export interface TRProps {
  readonly children: ReactNode;
  readonly hoverable?: boolean;
}

export function TR({ children, hoverable = true }: TRProps) {
  const hoverClass = hoverable ? 'hover:bg-[rgba(125,216,125,0.03)] transition-colors duration-150 cursor-pointer' : '';
  return <tr className={`align-middle ${hoverClass}`}>{children}</tr>;
}

export type CellAlign = 'left' | 'right' | 'center';

export interface THProps {
  readonly children: ReactNode;
  readonly align?: CellAlign;
  readonly width?: string;
}

const ALIGN_CLASS: Record<CellAlign, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function TH({ children, align = 'left', width }: THProps) {
  return (
    <th
      scope="col"
      style={width !== undefined ? { width } : undefined}
      className={`border-b border-rule px-4 py-3.5 font-mono ${ALIGN_CLASS[align]} text-[9px] font-medium uppercase tracking-[0.2em] text-text-muted`}
    >
      {children}
    </th>
  );
}

export interface TDProps {
  readonly children: ReactNode;
  readonly align?: CellAlign;
  readonly mono?: boolean;
  readonly muted?: boolean;
  readonly truncate?: boolean;
}

export function TD({ children, align = 'left', mono, muted, truncate }: TDProps) {
  const classes = [
    'border-b border-rule px-4 py-[18px]',
    ALIGN_CLASS[align],
    mono === true ? 'font-mono text-[11px] tabular-nums tracking-[0.04em]' : 'text-[13px]',
    muted === true ? 'text-text-tertiary' : 'text-text-primary',
    truncate === true ? 'max-w-xs truncate' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <td className={classes}>{children}</td>;
}
