import Link from 'next/link';

import type { ProjectStatusDotKind } from '@/components/StatusDot';
import { relativeTime } from '@/lib/format';

/**
 * `apps/web/components/ProjectCard.tsx` — editorial project tile.
 *
 * Mirrors brand-kit `.bk-card`: square 1px border on bg-surface, mono
 * eyebrow / label, serif italic project name with phosphor emphasis.
 * Three metric numbers in serif, mono footer with timestamp.
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

const STATUS: Record<ProjectStatusDotKind, { label: string; dot: string; text: string; ring: boolean }> = {
  green: { label: 'Active', dot: 'bg-accent', text: 'text-accent', ring: true },
  amber: { label: 'Paused', dot: 'bg-status-warning', text: 'text-status-warning', ring: false },
  red: { label: 'Alert', dot: 'bg-status-error', text: 'text-status-error', ring: false },
  gray: { label: 'Idle', dot: 'bg-text-muted', text: 'text-text-tertiary', ring: false },
};

export function ProjectCard(props: ProjectCardProps) {
  const lastActivityLabel =
    props.lastActivityAt === null ? 'No activity yet' : relativeTime(new Date(props.lastActivityAt));
  const status = STATUS[props.statusDot];
  return (
    <Link
      href={`/projects/${encodeURIComponent(props.slug)}` as never}
      data-testid="project-card"
      data-slug={props.slug}
      className="group flex cursor-pointer flex-col border border-rule bg-bg-surface p-7 transition-colors duration-200 hover:border-accent"
    >
      {/* Eyebrow · /run · slug */}
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
          /project · {props.slug}
        </span>
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 rounded-full ${status.dot} ${
              status.ring ? 'shadow-[0_0_6px_var(--color-accent-glow)]' : ''
            }`}
          />
          <span className={`font-mono text-[9px] uppercase tracking-[0.18em] ${status.text}`}>{status.label}</span>
        </span>
      </div>

      {/* Project name · serif */}
      <h3 className="heading-display mt-4 truncate text-[28px] leading-[1.05] text-text-primary">
        <span>{props.name}</span>
      </h3>
      {props.slug !== props.name ? (
        <p className="mt-1.5 truncate font-mono text-[11px] tracking-[0.04em] text-text-tertiary">{props.orgId}</p>
      ) : null}

      {/* Metrics · three serif numbers */}
      <div className="mt-7 grid grid-cols-3 gap-4">
        <Metric label="Runs" value={props.activeRuns} accent={props.activeRuns > 0 ? 'info' : 'neutral'} />
        <Metric label="Denials" value={props.denials24h} accent={props.denials24h > 0 ? 'error' : 'neutral'} />
        <Metric
          label="Pauses"
          value={props.activeKillSwitches}
          accent={props.activeKillSwitches > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {/* Footer · mono activity */}
      <div className="mt-6 flex items-center gap-2 border-t border-rule pt-4 font-mono text-[10px] tracking-[0.06em] text-text-muted">
        <span className="uppercase">Last</span>
        <span className="text-text-tertiary">{lastActivityLabel}</span>
      </div>
    </Link>
  );
}

const ACCENT: Record<'info' | 'warning' | 'error' | 'neutral', string> = {
  info: 'text-text-primary',
  warning: 'text-status-warning',
  error: 'text-status-error',
  neutral: 'text-text-primary',
};

function Metric({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: number;
  readonly accent: 'info' | 'warning' | 'error' | 'neutral';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={`num-display text-[36px] leading-none ${ACCENT[accent]}`}>
        {accent === 'info' && value > 0 ? <em>{value}</em> : value}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</span>
    </div>
  );
}
