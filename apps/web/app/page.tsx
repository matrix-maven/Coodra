import Link from 'next/link';

import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';
import { compactTimestamp, relativeTime } from '@/lib/format';
import { fetchDashboardSnapshot, fetchDoctorSummary } from '@/lib/queries/dashboard';

/**
 * `/` — Dashboard home (M04 S9). Five tiles + latest events list,
 * per `docs/feature-packs/04-web-app/wireframes/02-screens/dashboard.md`.
 *
 * Server-rendered every request. The live polling refresh wraps the
 * tiles in a future client component; for now we rely on browser-side
 * full-page revisits (the data is cheap to compute and doesn't
 * justify the polling client surface yet — defer to S9 follow-up).
 *
 * M04 Phase 2 S1 (F1, OQ-9 lock): `dynamic = 'force-dynamic'` so
 * tiles + the latest-events table reflect live DB state on every
 * request. Without this, Next.js 15 prerenders the page at build time
 * and bakes in stale counts (audit 2026-05-04 finding F1: dashboard
 * showed `Active runs: 3 / Denials: 546` against an empty post-purge
 * DB). Cost: ~4 fresh DB queries per dashboard hit; acceptable at
 * 1-10 dev scale per the OQ-9 cost note. Revisit with `revalidate: 5`
 * if /sync queue depth or DB CPU climbs in production.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const [snapshot, doctor] = await Promise.all([fetchDashboardSnapshot(), fetchDoctorSummary()]);
  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Dashboard</h1>
        <span className="font-mono text-xs text-(--color-text-tertiary)">
          Last refreshed {relativeTime(new Date(snapshot.fetchedAt))}
        </span>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Active runs"
          value={snapshot.activeRuns}
          tone={snapshot.activeRuns > 0 ? 'info' : 'neutral'}
          href="/runs?status=in_progress"
        />
        <Tile
          label="Denials · 24h"
          value={snapshot.denials24h}
          tone={snapshot.denials24h > 0 ? 'error' : 'success'}
          href="/runs"
        />
        <Tile
          label="Active pauses"
          value={snapshot.activeKillSwitches}
          tone={snapshot.activeKillSwitches > 0 ? 'warning' : 'neutral'}
          href="/kill-switches"
        />
        <DoctorTile snapshot={doctor} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide">Latest events</h2>
        {snapshot.latestEvents.length === 0 ? (
          <Empty
            hint={
              snapshot.mode === 'solo'
                ? 'Open Claude Code in this project to see events flow into this view.'
                : 'No events recorded across the org yet.'
            }
          />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Time</Th>
                <Th>Phase</Th>
                <Th>Tool</Th>
                <Th>Run</Th>
                <Th>Tool-use id</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.latestEvents.map((evt) => (
                <tr key={evt.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-secondary)">
                    {compactTimestamp(new Date(evt.createdAt))}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs uppercase text-(--color-text-tertiary)">{evt.phase}</td>
                  <td className="px-3 py-2">
                    <ToolBadge name={evt.toolName || '—'} />
                  </td>
                  <td className="px-3 py-2">
                    {evt.runId !== null ? (
                      <Link
                        href={`/runs/${encodeURIComponent(evt.runId)}` as never}
                        className="font-mono text-xs text-(--color-text-code) hover:text-(--color-brand-hover)"
                      >
                        {evt.runId.length > 30 ? `${evt.runId.slice(0, 30)}…` : evt.runId}
                      </Link>
                    ) : (
                      // M04 Phase 2 S1 (F4): label orphan rows. After F3 +
                      // 0008 backfill, run_id is never NULL in practice;
                      // this branch is the defensive fallback if a future
                      // bridge regression slips a NULL through.
                      <StatusChip status="neutral">untracked</StatusChip>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{evt.toolUseId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="self-end">
          <Link
            href="/runs"
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
          >
            View all runs ▸
          </Link>
        </div>
      </section>
    </div>
  );
}

const TONE_TEXT: Record<'info' | 'success' | 'warning' | 'error' | 'neutral', string> = {
  info: 'text-(--color-status-info)',
  success: 'text-(--color-status-success)',
  warning: 'text-(--color-status-warning)',
  error: 'text-(--color-status-error)',
  neutral: 'text-(--color-text-primary)',
};

function Tile({
  label,
  value,
  tone,
  href,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  readonly href: string;
}) {
  return (
    <Link
      href={href as never}
      className="group flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 hover:border-(--color-brand)"
    >
      <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}
      </div>
      <div className={`font-display text-5xl font-black ${TONE_TEXT[tone]}`}>{value}</div>
      <div className="mt-auto border-t border-(--color-border-subtle) pt-2 text-right font-display text-xs font-bold uppercase tracking-wider text-(--color-text-tertiary) group-hover:text-(--color-brand)">
        ▸
      </div>
    </Link>
  );
}

function DoctorTile({ snapshot }: { readonly snapshot: { red: number; yellow: number; available: boolean } }) {
  if (!snapshot.available) {
    return (
      <div className="flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
        <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
          Doctor
        </div>
        <div className="font-display text-2xl font-black text-(--color-text-tertiary)">—</div>
        <p className="text-xs text-(--color-text-tertiary)">
          Run <span className="font-mono">contextos doctor --full --json</span> for the per-machine report.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        Doctor
      </div>
      <div className="flex items-baseline gap-3">
        <span className="font-display text-3xl font-black text-(--color-status-error)">{snapshot.red}</span>
        <span className="font-mono text-xs uppercase text-(--color-text-tertiary)">red</span>
        <span className="font-display text-3xl font-black text-(--color-status-warning)">{snapshot.yellow}</span>
        <span className="font-mono text-xs uppercase text-(--color-text-tertiary)">yellow</span>
      </div>
    </div>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-12 text-center">
      <p className="font-display text-sm font-light uppercase tracking-wider text-(--color-text-secondary)">
        No activity yet.
      </p>
      <p className="mt-2 text-xs text-(--color-text-tertiary)">{hint}</p>
    </div>
  );
}
