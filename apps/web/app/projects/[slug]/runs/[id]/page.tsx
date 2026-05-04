import { notFound } from 'next/navigation';

import { DecisionCard } from '@/components/DecisionCard';
import { PolicyDecisionRow } from '@/components/PolicyDecisionRow';
import { RelativeTime } from '@/components/RelativeTime';
import { RunEventRow } from '@/components/RunEventRow';
import { RunStatusChip } from '@/components/RunStatusChip';
import {
  Breadcrumbs,
  Card,
  type Crumb,
  EmptyState,
  PageHeader,
  PageShell,
  Section,
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
 * `/projects/[slug]/runs/[id]` — server-rendered run detail per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/run-detail.md`,
 * restyled in Phase 2 UI.
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

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Runs', href: `${baseHref}/runs` },
    { label: run.id.length > 30 ? `${run.id.slice(0, 30)}…` : run.id, mono: true },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Run"
        title={run.id.length > 60 ? `${run.id.slice(0, 60)}…` : run.id}
        actions={<RunStatusChip status={run.status} />}
        subtitle={
          <>
            {events.length} event{events.length === 1 ? '' : 's'} · {decisions.length} decision
            {decisions.length === 1 ? '' : 's'} · {policyDecisions.length} policy decision
            {policyDecisions.length === 1 ? '' : 's'} · {contextPack !== null ? '1 context pack' : 'no context pack'}.
          </>
        }
      />

      <Card size="sm">
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          <Field label="Project" value={<span className="break-all font-mono text-xs">{run.projectId}</span>} />
          <Field label="Session" value={<span className="break-all font-mono text-xs">{run.sessionId}</span>} />
          <Field label="Agent" value={`${run.agentType} (${run.mode})`} />
          <Field label="Issue / PR" value={`${run.issueRef ?? '—'} / ${run.prRef ?? '—'}`} />
          <Field label="Started" value={<RelativeTime date={run.startedAt} mode="compact" />} />
          <Field
            label="Ended"
            value={
              run.endedAt === null ? (
                <span className="text-text-tertiary">(in progress)</span>
              ) : (
                <>
                  <RelativeTime date={run.endedAt} mode="compact" />
                  <span className="ml-2 text-text-tertiary">({compactDuration(startedMs, endedMs)})</span>
                </>
              )
            }
          />
        </dl>
      </Card>

      <Section title={`Events (${events.length})`}>
        {events.length === 0 ? (
          <EmptyState title="No events" body="No events recorded for this run." />
        ) : (
          <div className="border border-border-subtle">
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

      <Section title={`Decisions (${decisions.length})`}>
        {decisions.length === 0 ? (
          <EmptyState title="No decisions" body="Agent recorded no decisions." />
        ) : (
          <div className="flex flex-col gap-4">
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

      <Section title={`Audit (${policyDecisions.length})`}>
        {policyDecisions.length === 0 ? (
          <EmptyState title="No policy decisions" body="Bridge did not evaluate any policy rules for this run." />
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

      <Section title="Context pack">
        {contextPack === null ? (
          <EmptyState title="No context pack" body="The agent did not save a context pack for this run." />
        ) : (
          <Card size="md">
            <article className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-display text-lg font-bold text-text-primary">{contextPack.title}</h3>
                <span className="text-xs text-text-tertiary">
                  <RelativeTime date={contextPack.createdAt} mode="compact" />
                </span>
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-primary">
                {contextPack.contentExcerpt}
              </pre>
            </article>
          </Card>
        )}
      </Section>
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
