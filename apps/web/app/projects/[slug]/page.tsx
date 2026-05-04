import Link from 'next/link';

import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';
import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tile,
  TR,
} from '@/components/ui';
import { compactTimestamp, relativeTime } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getDoctorReport } from '@/lib/queries/doctor';
import { fetchProjectHomeSnapshot } from '@/lib/queries/project-home';

/**
 * `/projects/[slug]` — Project home dashboard (M04 Phase 2 S2b,
 * restyled in Phase 2 UI).
 *
 * 4 KPI tiles (active runs / denials / pauses / doctor) + latest
 * events + project info sidebar — every metric scoped to the URL-
 * bound project. Now composed entirely from the shared primitives
 * library so spacing, typography, and tile shape match every other
 * surface.
 */

export const dynamic = 'force-dynamic';

export default async function ProjectHomePage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const [snapshot, doctorReport] = await Promise.all([
    fetchProjectHomeSnapshot({ projectId: project.id, projectSlug: project.slug }),
    getDoctorReport('essential'),
  ]);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const doctorTotal = doctorReport.checks.length;
  const doctorTone: 'error' | 'warning' | 'success' =
    doctorReport.summary.fail > 0 ? 'error' : doctorReport.summary.warn > 0 ? 'warning' : 'success';
  const doctorHeadline =
    doctorReport.summary.fail > 0
      ? `${doctorReport.summary.fail} red`
      : doctorReport.summary.warn > 0
        ? `${doctorReport.summary.warn} yellow`
        : `${doctorReport.summary.ok}/${doctorTotal}`;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Project"
        title={project.slug}
        subtitle={
          <>
            Last refreshed {relativeTime(new Date(snapshot.fetchedAt))} ·{' '}
            <span className="font-mono uppercase">{snapshot.mode}</span> mode
          </>
        }
      />

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Active runs"
          value={snapshot.activeRuns}
          tone={snapshot.activeRuns > 0 ? 'info' : 'neutral'}
          href={`${baseHref}/runs?status=in_progress`}
          hint="Open agent sessions"
        />
        <Tile
          label="Denials · 24h"
          value={snapshot.denials24h}
          tone={snapshot.denials24h > 0 ? 'error' : 'success'}
          href={`${baseHref}/runs`}
          hint="Policy refusals last 24h"
        />
        <Tile
          label="Active pauses"
          value={snapshot.activeKillSwitches}
          tone={snapshot.activeKillSwitches > 0 ? 'warning' : 'neutral'}
          href={`${baseHref}/kill-switches`}
          hint="Kill switches engaged"
        />
        <Tile
          label="Doctor"
          value={doctorHeadline}
          tone={doctorTone}
          href={`${baseHref}/doctor`}
          hint={`${doctorReport.summary.ok} green · ${doctorReport.summary.warn} yellow · ${doctorReport.summary.fail} red of ${doctorTotal}`}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-(--space-stack) lg:col-span-2">
          <Section
            title="Latest events"
            count={snapshot.latestEvents.length}
            actions={
              <LinkButton href={`${baseHref}/runs`} variant="ghost" size="sm">
                View all runs
              </LinkButton>
            }
          >
            {snapshot.latestEvents.length === 0 ? (
              <EmptyState
                title="No events yet"
                body={`Open Claude Code in ${project.slug} to see events flow into this view.`}
              />
            ) : (
              <Table>
                <THead>
                  <TR hoverable={false}>
                    <TH>Time</TH>
                    <TH>Phase</TH>
                    <TH>Tool</TH>
                    <TH>Run</TH>
                    <TH>Tool-use id</TH>
                  </TR>
                </THead>
                <TBody>
                  {snapshot.latestEvents.map((evt) => (
                    <TR key={evt.id}>
                      <TD mono muted>
                        {compactTimestamp(new Date(evt.createdAt))}
                      </TD>
                      <TD mono muted>
                        {evt.phase}
                      </TD>
                      <TD>
                        <ToolBadge name={evt.toolName || '—'} />
                      </TD>
                      <TD mono>
                        {evt.runId !== null ? (
                          <Link
                            href={`${baseHref}/runs/${encodeURIComponent(evt.runId)}` as never}
                            className="text-text-code hover:text-brand-hover"
                          >
                            {evt.runId.length > 30 ? `${evt.runId.slice(0, 30)}…` : evt.runId}
                          </Link>
                        ) : (
                          <StatusChip status="neutral">untracked</StatusChip>
                        )}
                      </TD>
                      <TD mono muted>
                        {evt.toolUseId}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Section>
        </div>

        <aside className="flex flex-col gap-(--space-stack)">
          <Section
            title="Project info"
            actions={
              <LinkButton href={`${baseHref}/settings`} variant="ghost" size="sm">
                Settings
              </LinkButton>
            }
          >
            <Card size="sm">
              <dl className="flex flex-col gap-2 text-sm">
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
            </Card>
          </Section>
        </aside>
      </section>
    </PageShell>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
    </div>
  );
}
