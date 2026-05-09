import { notFound } from 'next/navigation';

import { DecisionCard } from '@/components/DecisionCard';
import { PolicyDecisionRow } from '@/components/PolicyDecisionRow';
import { RelativeTime } from '@/components/RelativeTime';
import { RunEventRow } from '@/components/RunEventRow';
import {
  Breadcrumbs,
  Card,
  CodeBlock,
  type Crumb,
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  StatPill,
  Table,
  TBody,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { compactDuration } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getRun } from '@/lib/queries/runs';

/**
 * `/projects/[slug]/runs/[id]` — editorial run detail (mirrors brand-kit
 * Run Detail, screen 04).
 *
 * Hero with serif italic title · 4-cell summary row · two-column grid
 * (event timeline left, context pack + decisions right).
 */
export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const result = await getRun(id);
  if (result === null) notFound();
  if (result.run.projectId !== project.id) notFound();
  const { run, events, decisions, policyDecisions, contextPack } = result;
  const startedMs = run.startedAt.getTime();
  const endedMs = run.endedAt?.getTime() ?? Date.now();
  const duration = compactDuration(startedMs, endedMs);

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Runs', href: `${baseHref}/runs` },
    { label: run.id.length > 18 ? `${run.id.slice(0, 18)}…` : run.id, mono: true },
  ];

  const allowCount = policyDecisions.filter((d) => d.permissionDecision === 'allow').length;
  const denyCount = policyDecisions.filter((d) => d.permissionDecision === 'deny').length;

  const statusTone =
    run.status === 'completed'
      ? 'ok'
      : run.status === 'failed'
        ? 'warn'
        : run.status === 'in_progress'
          ? 'ok'
          : 'neutral';

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />

      <PageHeader
        eyebrow={`/02 · AUDIT · RUN ${run.id.slice(0, 8)}`}
        title={<span>Run · {run.id.slice(0, 12)}</span>}
        subtitle={
          <>
            Session <span className="font-mono text-text-secondary">{run.sessionId.slice(0, 24)}</span> · started{' '}
            <RelativeTime date={run.startedAt} mode="compact" />
            {run.endedAt !== null ? (
              <>
                {' '}
                · ended <RelativeTime date={run.endedAt} mode="compact" />
              </>
            ) : null}
            {contextPack !== null ? (
              <>
                {' '}
                · pack landed at{' '}
                <span className="font-mono text-accent">~/.contextos/packs/run-{run.id.slice(0, 6)}.md</span>
              </>
            ) : null}
          </>
        }
        meta={
          <StatPill tone={statusTone} dot>
            {run.status}
          </StatPill>
        }
        actions={
          <>
            <LinkButton href={`${baseHref}/runs/${encodeURIComponent(run.id)}/live`} variant="ghost">
              Live
            </LinkButton>
            <LinkButton href={`${baseHref}/runs`} variant="primary">
              Back to runs
            </LinkButton>
          </>
        }
      />

      {/* Run summary row */}
      <div className="mb-12 grid grid-cols-4 border-y border-rule">
        <SummaryCell
          label="Duration"
          value={duration}
          sub={`${run.startedAt.toISOString().slice(11, 19)} → ${run.endedAt !== null ? run.endedAt.toISOString().slice(11, 19) : 'in progress'}`}
          divider
          emphasis
        />
        <SummaryCell label="Events" value={events.length} sub={`tool calls`} divider />
        <SummaryCell
          label="Decisions"
          value={`${allowCount}/${denyCount}`}
          sub={`${allowCount} allow · ${denyCount} deny`}
          divider
          emphasis
        />
        <SummaryCell label="Mode" value={run.mode} sub={run.agentType} />
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        {/* Event timeline */}
        <div className="flex flex-col gap-5">
          <Section
            title={
              <>
                Event <em>timeline</em>
              </>
            }
            count={`${events.length} events · chronological`}
          >
            {events.length === 0 ? (
              <EmptyState
                title={
                  <>
                    No <em>events</em>
                  </>
                }
                body="No events recorded for this run."
              />
            ) : (
              <div className="flex flex-col gap-1.5">
                {events.map((evt) => (
                  <RunEventRow
                    key={evt.id}
                    phase={evt.phase}
                    toolName={evt.toolName}
                    toolUseId={evt.toolUseId}
                    toolInput={evt.toolInput}
                    outcome={evt.outcome}
                    createdAt={evt.createdAt}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title={
              <>
                Audit <em>decisions</em>
              </>
            }
            count={`${policyDecisions.length} policy events`}
          >
            {policyDecisions.length === 0 ? (
              <EmptyState
                title={
                  <>
                    No <em>policy</em> decisions
                  </>
                }
                body="Bridge did not evaluate any policy rules for this run."
              />
            ) : (
              <Table>
                <THead>
                  <TR hoverable={false}>
                    <TH>Time</TH>
                    <TH>Decision</TH>
                    <TH>Tool</TH>
                    <TH>Reason</TH>
                    <TH>Matched rule</TH>
                  </TR>
                </THead>
                <TBody>
                  {policyDecisions.map((row) => (
                    <PolicyDecisionRow
                      key={row.id}
                      permissionDecision={row.permissionDecision}
                      toolName={row.toolName}
                      reason={row.reason}
                      matchedRuleId={row.matchedRuleId}
                      createdAt={row.createdAt}
                    />
                  ))}
                </TBody>
              </Table>
            )}
          </Section>
        </div>

        {/* Right column: pack + decisions */}
        <aside className="flex flex-col gap-4">
          <Card size="md">
            <Section
              title={
                <>
                  Context <em>pack</em>
                </>
              }
              compact
              actions={
                contextPack !== null ? (
                  <StatPill tone="ok" dot>
                    LANDED
                  </StatPill>
                ) : (
                  <StatPill tone="neutral" dot>
                    SKIP
                  </StatPill>
                )
              }
            >
              {contextPack === null ? (
                <p className="font-mono text-[11px] text-text-tertiary tracking-[0.04em]">
                  The agent did not save a context pack for this run.
                </p>
              ) : (
                <CodeBlock size="sm">
                  {`# ${contextPack.title}
# run · ${run.id.slice(0, 8)} · ${run.startedAt.toISOString().slice(0, 10)}

${contextPack.contentExcerpt.slice(0, 480)}`}
                </CodeBlock>
              )}
              {contextPack !== null ? (
                <div className="mt-4 flex gap-1.5">
                  <LinkButton href="#" variant="secondary" size="sm">
                    Open file
                  </LinkButton>
                  <LinkButton href="#" variant="ghost" size="sm">
                    Copy
                  </LinkButton>
                </div>
              ) : null}
            </Section>
          </Card>

          <Card size="md">
            <Section title={<>Decisions</>} count={`${decisions.length} recorded`} compact>
              {decisions.length === 0 ? (
                <p className="font-mono text-[11px] text-text-tertiary tracking-[0.04em]">
                  Agent recorded no decisions.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {decisions.map((dec) => (
                    <DecisionCard
                      key={dec.id}
                      description={dec.description}
                      rationale={dec.rationale}
                      alternatives={dec.alternatives}
                      createdAt={dec.createdAt}
                    />
                  ))}
                </div>
              )}
            </Section>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function SummaryCell({
  label,
  value,
  sub,
  divider,
  emphasis,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly sub: string;
  readonly divider?: boolean;
  readonly emphasis?: boolean;
}) {
  const dividerCls = divider === true ? 'border-r border-rule' : '';
  return (
    <div className={`px-7 py-7 ${dividerCls}`}>
      <div className="eyebrow mb-3 text-text-muted">{label}</div>
      <div className="num-display text-[36px] leading-[1] text-text-primary">{emphasis ? <em>{value}</em> : value}</div>
      <div className="mt-2 font-mono text-[10px] tracking-[0.06em] text-text-tertiary">{sub}</div>
    </div>
  );
}
