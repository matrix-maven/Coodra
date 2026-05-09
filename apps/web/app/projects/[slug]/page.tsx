import Link from 'next/link';

import { CopyButton } from '@/components/CopyButton';
import { Card, CodeBlock, EmptyState, EventRow, LinkButton, PageHeader, Section, StatPill } from '@/components/ui';
import { compactTimestamp, relativeTime } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getDoctorReport } from '@/lib/queries/doctor';
import { fetchProjectHomeSnapshot } from '@/lib/queries/project-home';

/**
 * `/projects/[slug]` — editorial project home (mirrors brand-kit
 * Project Overview, screen 02).
 *
 * Hero: editorial title with phosphor italic emphasis + meta strip.
 * Stats row · 4 cells. Recent runs (left, ~2/3) · System / shape (right).
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

  const projectTone: 'ok' | 'warn' | 'caution' | 'neutral' =
    snapshot.denials24h > 0
      ? 'warn'
      : snapshot.activeKillSwitches > 0
        ? 'caution'
        : snapshot.activeRuns > 0
          ? 'ok'
          : 'neutral';
  const projectStatusLabel =
    snapshot.denials24h > 0
      ? 'ALERT'
      : snapshot.activeKillSwitches > 0
        ? 'PAUSED'
        : snapshot.activeRuns > 0
          ? 'ACTIVE'
          : 'IDLE';

  return (
    <div className="flex flex-col">
      <PageHeader
        eyebrow={`/01 · PROJECT · ${project.slug}`}
        title={<span>{project.name}</span>}
        subtitle={
          <>
            Local-first MCP coordination layer. Every run leaves a trace; every decision survives a crash. Last
            refreshed{' '}
            <span className="font-mono text-text-secondary">{relativeTime(new Date(snapshot.fetchedAt))}</span>.
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">{project.id.slice(0, 13)}</strong>
            <br />
            org · {project.orgId}
            <br />
            mode · {snapshot.mode}
          </>
        }
        actions={
          <>
            <LinkButton href={`${baseHref}/settings`} variant="ghost">
              Settings
            </LinkButton>
            <LinkButton href={`${baseHref}/runs`} variant="primary">
              Open runs
            </LinkButton>
          </>
        }
      />

      {/* Status meta strip */}
      <div className="mb-14 flex flex-wrap items-center gap-2">
        <StatPill tone={projectTone} dot>
          {projectStatusLabel}
        </StatPill>
        <StatPill tone="neutral">org · {project.orgId}</StatPill>
        <StatPill tone="neutral">slug · {project.slug}</StatPill>
        <StatPill tone="neutral">
          created · {project.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
        </StatPill>
      </div>

      {/* Stat row */}
      <div className="mb-14 grid grid-cols-4 border-y border-rule">
        <StatCell
          label="Active runs"
          value={snapshot.activeRuns}
          hint="Open agent sessions"
          divider
          emphasis={snapshot.activeRuns > 0}
        />
        <StatCell
          label="Denials · 24h"
          value={snapshot.denials24h}
          hint="Policy refusals"
          divider
          tone={snapshot.denials24h > 0 ? 'error' : 'neutral'}
        />
        <StatCell
          label="Active pauses"
          value={snapshot.activeKillSwitches}
          hint="Kill switches engaged"
          divider
          tone={snapshot.activeKillSwitches > 0 ? 'warning' : 'neutral'}
        />
        <StatCell
          label="Doctor"
          value={
            doctorReport.summary.fail > 0
              ? doctorReport.summary.fail
              : doctorReport.summary.warn > 0
                ? doctorReport.summary.warn
                : `${doctorReport.summary.ok}/${doctorTotal}`
          }
          hint={`${doctorReport.summary.ok} green · ${doctorReport.summary.warn} yellow · ${doctorReport.summary.fail} red`}
          tone={doctorTone === 'success' ? 'neutral' : doctorTone === 'warning' ? 'warning' : 'error'}
        />
      </div>

      {/* Recent events + side panels */}
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-5">
          <Section
            title={
              <>
                Latest <em>events</em>
              </>
            }
            count={`${snapshot.latestEvents.length} · last 24h`}
            actions={
              <LinkButton href={`${baseHref}/runs`} variant="ghost" size="sm">
                View all runs
              </LinkButton>
            }
          >
            {snapshot.latestEvents.length === 0 ? (
              <EmptyState
                title={
                  <>
                    No <em>events</em> yet
                  </>
                }
                body={`Open Claude Code in ${project.slug} to see events flow into this view.`}
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                {snapshot.latestEvents.map((evt) => (
                  <EventRow
                    key={evt.id}
                    time={compactTimestamp(new Date(evt.createdAt))}
                    tool={
                      <>
                        <span className="text-text-tertiary">{evt.phase.toLowerCase()}</span>
                        <span className="mx-2 text-text-muted">·</span>
                        <b className="text-accent">{evt.toolName || '—'}</b>
                        {evt.runId !== null ? (
                          <>
                            <span className="mx-2 text-text-muted">·</span>
                            <Link
                              href={`${baseHref}/runs/${encodeURIComponent(evt.runId)}` as never}
                              className="text-text-tertiary underline decoration-rule decoration-1 underline-offset-[3px] hover:decoration-text-primary hover:text-text-primary"
                            >
                              {evt.runId.length > 22 ? `${evt.runId.slice(0, 22)}…` : evt.runId}
                            </Link>
                          </>
                        ) : (
                          <>
                            <span className="mx-2 text-text-muted">·</span>
                            <span className="text-text-muted">untracked</span>
                          </>
                        )}
                      </>
                    }
                    duration=""
                    verdict={evt.phase}
                    verdictTone={evt.phase.toLowerCase() === 'pre' ? 'pending' : 'allow'}
                  />
                ))}
              </div>
            )}
          </Section>
        </div>

        <aside className="flex flex-col gap-4">
          <Card size="md">
            <Section
              title={
                <>
                  Project <em>shape</em>
                </>
              }
              compact
            >
              <CodeBlock
                size="sm"
                html={`<span class="cm"># .contextos.json</span>
<span class="ck">{</span>
  <span class="ck">"slug"</span>: <span class="cw">"${project.slug}"</span>,
  <span class="ck">"projectId"</span>: <span class="cw">"${project.id.slice(0, 8)}…"</span>,
  <span class="ck">"orgId"</span>: <span class="cw">"${project.orgId}"</span>,
  <span class="ck">"mode"</span>: <span class="cw">"${snapshot.mode}"</span>
<span class="ck">}</span>`}
              />
            </Section>
          </Card>

          <Card size="md">
            <Section
              title={
                <>
                  Project <em>info</em>
                </>
              }
              compact
              actions={<CopyButton value={project.id} label="Copy project id" />}
            >
              <dl className="flex flex-col">
                <InfoRow label="Slug" value={project.slug} mono />
                <InfoRow label="ID" value={project.id} mono small />
                <InfoRow label="Org" value={project.orgId} mono />
                <InfoRow
                  label="Created"
                  value={`${project.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}`}
                />
              </dl>
            </Section>
          </Card>

          <Card size="md">
            <Section
              title={
                <>
                  Quick <em>links</em>
                </>
              }
              compact
            >
              <div className="mt-2 flex flex-col gap-1">
                <QuickLink href={`${baseHref}/runs`} label="Run history" />
                <QuickLink href={`${baseHref}/policies`} label="Policies" />
                <QuickLink href={`${baseHref}/kill-switches`} label="Kill switches" />
                <QuickLink href={`${baseHref}/packs`} label="Feature packs" />
                <QuickLink href={`${baseHref}/doctor`} label="Doctor" />
              </div>
            </Section>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/* ───────────────────────── Subcomponents ───────────────────────── */

function StatCell({
  label,
  value,
  hint,
  emphasis,
  tone,
  divider,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly hint: string;
  readonly emphasis?: boolean;
  readonly tone?: 'neutral' | 'error' | 'warning';
  readonly divider?: boolean;
}) {
  const dividerCls = divider === true ? 'border-r border-rule' : '';
  const hintCls =
    tone === 'error' ? 'text-status-error' : tone === 'warning' ? 'text-status-warning' : 'text-text-tertiary';
  return (
    <div className={`px-7 py-8 ${dividerCls}`}>
      <div className="eyebrow mb-5 text-text-tertiary">{label}</div>
      <div className="num-display text-[64px] leading-[0.95] text-text-primary">
        {emphasis ? <em>{value}</em> : value}
      </div>
      <div className={`mt-3 font-mono text-[10px] tracking-[0.08em] ${hintCls}`}>{hint}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono,
  small,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly small?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-rule py-3 last:border-b-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span
          className={`min-w-0 truncate text-[12px] text-text-primary ${mono === true ? 'font-mono tracking-[0.04em]' : ''} ${small === true ? 'text-[11px]' : ''}`}
        >
          {value}
        </span>
        <CopyButton value={value} label={`Copy ${label}`} />
      </dd>
    </div>
  );
}

function QuickLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <Link
      href={href as never}
      className="group flex items-center justify-between border-b border-rule py-2.5 font-mono text-[11px] tracking-[0.04em] text-text-tertiary transition-colors hover:text-accent last:border-b-0"
    >
      <span>{label}</span>
      <span className="text-text-muted transition-colors group-hover:text-accent">→</span>
    </Link>
  );
}
