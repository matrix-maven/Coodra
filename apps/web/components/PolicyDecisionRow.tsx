import { RelativeTime } from './RelativeTime';
import { StatusChip, type StatusChipKind } from './StatusChip';
import { ToolBadge } from './ToolBadge';

/**
 * Single row in the run-detail audit table per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/run-detail.md`.
 * Maps `permission_decision` to the brand status palette.
 */

const DECISION_MAP: Record<string, StatusChipKind> = {
  allow: 'success',
  deny: 'error',
  ask: 'warning',
};

export interface PolicyDecisionRowProps {
  readonly permissionDecision: string;
  readonly toolName: string;
  readonly reason: string;
  readonly matchedRuleId: string | null;
  readonly createdAt: Date;
}

export function PolicyDecisionRow({
  permissionDecision,
  toolName,
  reason,
  matchedRuleId,
  createdAt,
}: PolicyDecisionRowProps) {
  const kind = DECISION_MAP[permissionDecision] ?? 'neutral';
  // Truncate reason to 80 chars in the table; full text on hover.
  const displayReason = reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
  return (
    <tr className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
      <td className="px-3 py-2 text-xs text-(--color-text-secondary)">
        <RelativeTime date={createdAt} mode="compact" />
      </td>
      <td className="px-3 py-2">
        <StatusChip status={kind}>{permissionDecision}</StatusChip>
      </td>
      <td className="px-3 py-2">
        <ToolBadge name={toolName || '—'} />
      </td>
      <td className="px-3 py-2 text-sm text-(--color-text-primary)" title={reason}>
        {displayReason}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{matchedRuleId ?? '—'}</td>
    </tr>
  );
}
