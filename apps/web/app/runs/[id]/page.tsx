import { notFound } from 'next/navigation';

import { DecisionCard } from '@/components/DecisionCard';
import { PolicyDecisionRow } from '@/components/PolicyDecisionRow';
import { RelativeTime } from '@/components/RelativeTime';
import { RunEventRow } from '@/components/RunEventRow';
import { RunStatusChip } from '@/components/RunStatusChip';
import { compactDuration } from '@/lib/format';
import { getRun } from '@/lib/queries/runs';

/**
 * `/runs/[id]` — server-rendered run detail per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/run-detail.md`.
 *
 * Tabs render via URL hash (`#events`, `#decisions`, `#audit`,
 * `#context-pack`). S3 uses anchor sections — every section renders
 * server-side; the hash is just deep-link state. A future client-only
 * tab strip can be added without changing this page.
 *
 * Audit always visible (web is human-reading; nothing dropped to fit
 * a Slack post — per OQ-7 web vs CLI export).
 */

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  // Next.js's dynamic-route layer URL-encodes path segments before
  // exposing them via params (so `run:abc` arrives as `run%3Aabc`).
  // Run ids in our schema use the literal `:` from M03's run-key
  // format. Decode here so getRun can do an exact match against
  // `runs.id`.
  const id = decodeURIComponent(rawId);
  const result = await getRun(id);
  if (result === null) notFound();
  const { run, events, decisions, policyDecisions, contextPack } = result;
  const startedMs = run.startedAt.getTime();
  const endedMs = run.endedAt?.getTime() ?? Date.now();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono text-3xl font-medium text-(--color-text-primary)">{run.id}</h1>
          <RunStatusChip status={run.status} />
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          <Field label="Project" value={<span className="font-mono">{run.projectId}</span>} />
          <Field label="Session" value={<span className="font-mono">{run.sessionId}</span>} />
          <Field label="Agent" value={`${run.agentType} (${run.mode})`} />
          <Field label="Issue / PR" value={`${run.issueRef ?? '—'} / ${run.prRef ?? '—'}`} />
          <Field label="Started" value={<RelativeTime date={run.startedAt} mode="compact" />} />
          <Field
            label="Ended"
            value={
              run.endedAt === null ? (
                <span className="text-(--color-text-tertiary)">(in progress)</span>
              ) : (
                <>
                  <RelativeTime date={run.endedAt} mode="compact" />
                  <span className="ml-2 text-(--color-text-tertiary)">({compactDuration(startedMs, endedMs)})</span>
                </>
              )
            }
          />
        </dl>
      </header>

      <Section id="overview" title={`Overview`}>
        <p className="text-sm text-(--color-text-secondary)">
          {events.length} tool-use event{events.length === 1 ? '' : 's'} · {decisions.length} decision
          {decisions.length === 1 ? '' : 's'} · {policyDecisions.length} policy decision
          {policyDecisions.length === 1 ? '' : 's'} · {contextPack !== null ? '1 context pack' : 'no context pack'}.
        </p>
      </Section>

      <Section id="events" title={`Events (${events.length})`}>
        {events.length === 0 ? (
          <Empty hint="No events recorded for this run." />
        ) : (
          <div className="border border-(--color-border-subtle)">
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

      <Section id="decisions" title={`Decisions (${decisions.length})`}>
        {decisions.length === 0 ? (
          <Empty hint="Agent recorded no decisions." />
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

      <Section id="audit" title={`Audit (${policyDecisions.length})`}>
        {policyDecisions.length === 0 ? (
          <Empty hint="No policy decisions for this run." />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Time</Th>
                <Th>Decision</Th>
                <Th>Tool</Th>
                <Th>Reason</Th>
                <Th>Matched rule</Th>
              </tr>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        )}
      </Section>

      <Section id="context-pack" title="Context pack">
        {contextPack === null ? (
          <Empty hint="No context pack saved for this run." />
        ) : (
          <article className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
            <h3 className="font-display text-lg font-bold text-(--color-text-primary)">{contextPack.title}</h3>
            <div className="mt-1 text-xs text-(--color-text-tertiary)">
              <RelativeTime date={contextPack.createdAt} mode="compact" />
            </div>
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-(--color-text-primary)">
              {contextPack.contentExcerpt}
            </pre>
          </article>
        )}
      </Section>
    </div>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}:
      </dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-3 scroll-mt-32">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-tertiary)">
      {hint}
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
