import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/DataTable.tsx` — refined table primitive.
 *
 * Rounded outer container (radius-lg), soft border, subtle header
 * background, hover row tint. Cells use consistent padding + an
 * align toggle. `mono` renders the cell in JetBrains Mono (slugs);
 * `muted` drops to text-tertiary; `truncate` adds ellipsis.
 */

export interface TableProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Table({ children, className }: TableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-default bg-bg-surface shadow-xs">
      <div className="overflow-x-auto">
        <table className={`w-full text-sm${className !== undefined ? ` ${className}` : ''}`}>{children}</table>
      </div>
    </div>
  );
}

export function THead({ children }: { readonly children: ReactNode }) {
  return <thead className="bg-bg-elevated">{children}</thead>;
}

export function TBody({ children }: { readonly children: ReactNode }) {
  return <tbody className="divide-y divide-border-subtle">{children}</tbody>;
}

export interface TRProps {
  readonly children: ReactNode;
  readonly hoverable?: boolean;
}

export function TR({ children, hoverable = true }: TRProps) {
  const hoverClass = hoverable ? 'hover:bg-bg-elevated transition-colors duration-150' : '';
  return <tr className={`align-top ${hoverClass}`}>{children}</tr>;
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
      className={`px-4 py-2.5 ${ALIGN_CLASS[align]} text-xs font-medium text-text-tertiary`}
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
    'px-4 py-3',
    ALIGN_CLASS[align],
    mono === true ? 'font-mono text-xs' : 'text-sm',
    muted === true ? 'text-text-tertiary' : 'text-text-primary',
    truncate === true ? 'max-w-xs truncate' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <td className={classes}>{children}</td>;
}
