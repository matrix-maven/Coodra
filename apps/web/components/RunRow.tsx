import Link from 'next/link';

import { RelativeTime } from './RelativeTime';
import { RunStatusChip } from './RunStatusChip';
import { ToolBadge } from './ToolBadge';

/**
 * Single row in `/runs` table per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/runs-list.md`.
 * Server-rendered. Click navigates to `/runs/[id]`.
 */

export interface RunRowProps {
  readonly id: string;
  readonly status: string;
  readonly agentType: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export function RunRow({ id, status, agentType, sessionId, startedAt }: RunRowProps) {
  return (
    <tr className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
      <td className="px-3 py-3">
        <Link
          href={`/runs/${id}` as never}
          className="font-mono text-sm font-medium text-(--color-text-code) hover:text-(--color-brand-hover)"
        >
          {id}
        </Link>
      </td>
      <td className="px-3 py-3">
        <RunStatusChip status={status} />
      </td>
      <td className="px-3 py-3">
        <ToolBadge name={agentType} />
      </td>
      <td className="px-3 py-3 text-sm text-(--color-text-secondary)">
        <RelativeTime date={startedAt} />
      </td>
      <td className="px-3 py-3 font-mono text-xs text-(--color-text-tertiary)">{sessionId}</td>
    </tr>
  );
}
