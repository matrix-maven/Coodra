/**
 * `apps/web/components/StatusDot.tsx` — small colored circle for
 * project status (M04 Phase 2 S2b picker hub).
 *
 * Maps the picker's heuristic status string to brand status palette
 * tokens. Renders inline so it can sit next to a project name.
 */

export type ProjectStatusDotKind = 'green' | 'amber' | 'red' | 'gray';

const COLOR_MAP: Record<ProjectStatusDotKind, string> = {
  green: 'bg-status-success',
  amber: 'bg-status-warning',
  red: 'bg-status-error',
  gray: 'bg-text-muted',
};

const LABEL_MAP: Record<ProjectStatusDotKind, string> = {
  green: 'Active',
  amber: 'Paused',
  red: 'Denials in last 24h',
  gray: 'Idle',
};

export function StatusDot({ kind }: { readonly kind: ProjectStatusDotKind }) {
  return (
    <span
      data-testid="status-dot"
      data-kind={kind}
      title={LABEL_MAP[kind]}
      className={`inline-block h-2 w-2 rounded-full ${COLOR_MAP[kind]}`}
    />
  );
}
