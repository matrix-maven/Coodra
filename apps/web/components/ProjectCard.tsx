import Link from 'next/link';

import { type ProjectStatusDotKind, StatusDot } from '@/components/StatusDot';
import { ChevronRightIcon } from '@/components/ui';
import { relativeTime } from '@/lib/format';

/**
 * `apps/web/components/ProjectCard.tsx` — project tile for the `/`
 * picker hub. Refined for the new design: rounded card, soft shadow,
 * lift-on-hover, three-metric strip + footer with org + last-activity.
 */

export interface ProjectCardProps {
  readonly slug: string;
  readonly name: string;
  readonly orgId: string;
  readonly activeRuns: number;
  readonly denials24h: number;
  readonly activeKillSwitches: number;
  readonly lastActivityAt: string | null;
  readonly statusDot: ProjectStatusDotKind;
}

export function ProjectCard(props: ProjectCardProps) {
  const lastActivityLabel =
    props.lastActivityAt === null ? 'No activity yet' : relativeTime(new Date(props.lastActivityAt));
  return (
    <Link
      href={`/projects/${encodeURIComponent(props.slug)}` as never}
      data-testid="project-card"
      data-slug={props.slug}
      className="group flex cursor-pointer flex-col rounded-lg border border-border-default bg-bg-surface shadow-xs transition-all duration-200 hover:border-border-strong hover:shadow-md"
    >
      <div className="flex items-center gap-3 px-5 py-4">
        <StatusDot kind={props.statusDot} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-mono text-sm font-medium text-text-primary">{props.slug}</h3>
          <p className="truncate text-xs text-text-tertiary">{props.name}</p>
        </div>
        <ChevronRightIcon className="h-4 w-4 text-text-muted transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-text-secondary" />
      </div>
      <div className="grid grid-cols-3 border-t border-border-subtle">
        <Metric label="Active runs" value={props.activeRuns} tone={props.activeRuns > 0 ? 'info' : 'muted'} />
        <Metric
          label="Denials · 24h"
          value={props.denials24h}
          tone={props.denials24h > 0 ? 'error' : 'muted'}
          divider
        />
        <Metric
          label="Pauses"
          value={props.activeKillSwitches}
          tone={props.activeKillSwitches > 0 ? 'warning' : 'muted'}
          divider
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-5 py-3 text-xs">
        <span className="text-text-tertiary">{lastActivityLabel}</span>
        <span className="font-mono text-text-muted">{props.orgId}</span>
      </div>
    </Link>
  );
}

const TONE_TEXT: Record<'info' | 'warning' | 'error' | 'muted', string> = {
  info: 'text-status-info',
  warning: 'text-status-warning',
  error: 'text-status-error',
  muted: 'text-text-secondary',
};

function Metric({
  label,
  value,
  tone,
  divider,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'info' | 'warning' | 'error' | 'muted';
  readonly divider?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-start gap-0.5 px-4 py-3 ${divider === true ? 'border-l border-border-subtle' : ''}`}
    >
      <span className={`font-display text-xl font-semibold ${TONE_TEXT[tone]}`}>{value}</span>
      <span className="text-[11px] text-text-tertiary">{label}</span>
    </div>
  );
}
