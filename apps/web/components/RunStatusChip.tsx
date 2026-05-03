import { StatusChip, type StatusChipKind } from './StatusChip';

/**
 * Maps a run's `status` field to the brand status palette per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/runs-list.md`:
 *   in_progress → info
 *   completed   → success
 *   cancelled   → neutral
 *   failed      → error
 *   anything else → neutral (defensive)
 */

const STATUS_MAP: Record<string, StatusChipKind> = {
  in_progress: 'info',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'error',
};

export function RunStatusChip({ status }: { readonly status: string }) {
  const kind = STATUS_MAP[status] ?? 'neutral';
  return <StatusChip status={kind}>{status}</StatusChip>;
}
