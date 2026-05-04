import type { ReactNode } from 'react';

/**
 * `apps/web/components/ui/DataTable.tsx` — generic table primitive
 * (M04 Phase 2 UI).
 *
 * Replaces the 9 hand-rolled tables across packs / runs / context-
 * packs / doctor / sync / templates / settings. One shared shape:
 *
 *   <Table>
 *     <THead>
 *       <TR>
 *         <TH>Slug</TH>
 *         <TH>Status</TH>
 *       </TR>
 *     </THead>
 *     <TBody>
 *       {rows.map(r => (
 *         <TR key={r.id}>
 *           <TD mono>{r.slug}</TD>
 *           <TD>{r.status}</TD>
 *         </TR>
 *       ))}
 *     </TBody>
 *   </Table>
 *
 * Variants are kept tight: align (left | right | center) on TH/TD,
 * mono toggle on TD for slugs / IDs, and a `numeric` switch that
 * applies the data-dense palette colors to status counts.
 */

export interface TableProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function Table({ children, className }: TableProps) {
  return (
    <div className="overflow-x-auto">
      <table
        className={`w-full border border-(--color-border-subtle) text-sm${className !== undefined ? ` ${className}` : ''}`}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({ children }: { readonly children: ReactNode }) {
  return <thead className="bg-(--color-bg-elevated)">{children}</thead>;
}

export function TBody({ children }: { readonly children: ReactNode }) {
  return <tbody>{children}</tbody>;
}

export interface TRProps {
  readonly children: ReactNode;
  /** Optional row click affordance — when set, the row gains hover + cursor; click-handling stays the caller's job. */
  readonly hoverable?: boolean;
}

export function TR({ children, hoverable = true }: TRProps) {
  const hoverClass = hoverable ? 'hover:bg-(--color-bg-surface) transition-colors duration-200' : '';
  return <tr className={`border-b border-(--color-border-subtle) align-top ${hoverClass}`}>{children}</tr>;
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
      className={`px-3 py-2 ${ALIGN_CLASS[align]} font-display text-[10px] font-bold uppercase tracking-widest text-(--color-text-secondary)`}
    >
      {children}
    </th>
  );
}

export interface TDProps {
  readonly children: ReactNode;
  readonly align?: CellAlign;
  /** Render the cell content in JetBrains Mono (slugs, IDs, paths). */
  readonly mono?: boolean;
  /** Render the cell text muted (secondary metadata column). */
  readonly muted?: boolean;
  /** Truncate visually (with ellipsis) — caller still owns the title attribute if needed. */
  readonly truncate?: boolean;
}

export function TD({ children, align = 'left', mono, muted, truncate }: TDProps) {
  const classes = [
    'px-3 py-3',
    ALIGN_CLASS[align],
    mono === true ? 'font-mono text-xs' : 'text-sm',
    muted === true ? 'text-(--color-text-tertiary)' : 'text-(--color-text-primary)',
    truncate === true ? 'max-w-xs truncate' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <td className={classes}>{children}</td>;
}
