import Link from 'next/link';
import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';
import { compactTimestamp, relativeTime } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getDoctorReport } from '@/lib/queries/doctor';
import { fetchProjectHomeSnapshot } from '@/lib/queries/project-home';

/**
 * `/projects/[slug]` — Project home dashboard (M04 Phase 2 S2b).
 *
 * 4 tiles + latest events + project info sidebar — every metric
 * scoped to the URL-bound project. Replaces the Phase 1 `/`
 * dashboard which conflated all projects' data into one surface.
 */

export const dynamic = 'force-dynamic';

export default async function ProjectHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const [snapshot, doctorReport] = await Promise.all([
    fetchProjectHomeSnapshot({ projectId: project.id, projectSlug: project.slug }),
    getDoctorReport('essential'),
  ]);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-baseline lg:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-[56px] leading-[64px] font-black uppercase tracking-wide">{project.slug}</h1>
          <p className="text-sm text-(--color-text-secondary)">
            Last refreshed {relativeTime(new Date(snapshot.fetchedAt))} ·{' '}
            <span className="font-mono uppercase">{snapshot.mode}</span> mode
          </p>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Active runs"
          value={snapshot.activeRuns}
          tone={snapshot.activeRuns > 0 ? 'info' : 'neutral'}
          href={`${baseHref}/runs?status=in_progress`}
        />
        <Tile
          label="Denials · 24h"
          value={snapshot.denials24h}
          tone={snapshot.denials24h > 0 ? 'error' : 'success'}
          href={`${baseHref}/runs`}
        />
        <Tile
          label="Active pauses"
          value={snapshot.activeKillSwitches}
          tone={snapshot.activeKillSwitches > 0 ? 'warning' : 'neutral'}
          href={`${baseHref}/kill-switches`}
        />
        <DoctorTile
          baseHref={baseHref}
          ok={doctorReport.summary.ok}
          warn={doctorReport.summary.warn}
          fail={doctorReport.summary.fail}
          total={doctorReport.checks.length}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-3">
          <h2 className="font-display text-xl font-bold uppercase tracking-wide">Latest events</h2>
          {snapshot.latestEvents.length === 0 ? (
            <Empty hint={`Open Claude Code in ${project.slug} to see events flow into this view.`} />
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
                          href={`${baseHref}/runs/${encodeURIComponent(evt.runId)}` as never}
                          className="font-mono text-xs text-(--color-text-code) hover:text-(--color-brand-hover)"
                        >
                          {evt.runId.length > 30 ? `${evt.runId.slice(0, 30)}…` : evt.runId}
                        </Link>
                      ) : (
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
              href={`${baseHref}/runs` as never}
              className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
            >
              View all runs ▸
            </Link>
          </div>
        </div>

        <aside className="flex flex-col gap-3">
          <h2 className="font-display text-xl font-bold uppercase tracking-wide">Project info</h2>
          <dl className="flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-4 text-sm">
            <Field label="Slug" value={<span className="font-mono">{project.slug}</span>} />
            <Field label="ID" value={<span className="font-mono text-xs">{project.id}</span>} />
            <Field label="Org" value={<span className="font-mono">{project.orgId}</span>} />
            <Field label="Name" value={project.name} />
            <Field
              label="Created"
              value={
                <span className="font-mono text-xs">
                  {project.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                </span>
              }
            />
          </dl>
          <Link
            href={`${baseHref}/settings` as never}
            className="self-start font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
          >
            Project settings ▸
          </Link>
        </aside>
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

function DoctorTile({
  baseHref,
  ok,
  warn,
  fail,
  total,
}: {
  readonly baseHref: string;
  readonly ok: number;
  readonly warn: number;
  readonly fail: number;
  readonly total: number;
}) {
  // Tone follows worst-status: any red → error, any yellow → warning, else success.
  const tone: 'error' | 'warning' | 'success' = fail > 0 ? 'error' : warn > 0 ? 'warning' : 'success';
  const headline = fail > 0 ? `${fail} red` : warn > 0 ? `${warn} yellow` : `${ok}/${total} OK`;
  return (
    <Link
      href={`${baseHref}/doctor` as never}
      className="group flex flex-col gap-2 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 hover:border-(--color-brand)"
    >
      <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        Doctor
      </div>
      <div className={`font-display text-5xl font-black ${TONE_TEXT[tone]}`}>{headline}</div>
      <p className="text-xs text-(--color-text-tertiary)">
        {ok} green · {warn} yellow · {fail} red of {total} essential checks.
      </p>
      <div className="mt-auto border-t border-(--color-border-subtle) pt-2 text-right font-display text-xs font-bold uppercase tracking-wider text-(--color-text-tertiary) group-hover:text-(--color-brand)">
        ▸
      </div>
    </Link>
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

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">{label}</dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}
