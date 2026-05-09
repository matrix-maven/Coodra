import Link from 'next/link';

import { RelativeTime } from './RelativeTime';
import { RunStatusChip } from './RunStatusChip';
import { ToolBadge } from './ToolBadge';

/**
 * Single row in the runs list — compact, scannable, premium UI.
 *
 * Truncates the ID middle so the unique tail is visible without
 * 70-char monospace soup. Status pill anchors the row visually.
 */

export interface RunRowProps {
  readonly id: string;
  readonly status: string;
  readonly agentType: string;
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  /** URL-decoded project slug — used to build the run-detail link. */
  readonly projectSlug: string;
}

export function RunRow({ id, status, agentType, sessionId, startedAt, projectSlug }: RunRowProps) {
  const shortId = truncateMiddle(id, 28);
  return (
    <tr className="group transition-colors hover:bg-bg-hover">
      <td className="px-4 py-3">
        <RunStatusChip status={status} />
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/projects/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(id)}` as never}
          className="font-mono text-[12px] text-text-primary underline decoration-border-default decoration-1 underline-offset-[3px] tabular-nums hover:decoration-text-primary"
          title={id}
        >
          {shortId}
        </Link>
      </td>
      <td className="px-4 py-3">
        <ToolBadge name={agentType} />
      </td>
      <td className="px-4 py-3 text-[13px] text-text-secondary">
        <RelativeTime date={startedAt} />
      </td>
      <td className="px-4 py-3 font-mono text-[11px] text-text-tertiary tabular-nums" title={sessionId}>
        {truncateMiddle(sessionId, 28)}
      </td>
    </tr>
  );
}

function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}
