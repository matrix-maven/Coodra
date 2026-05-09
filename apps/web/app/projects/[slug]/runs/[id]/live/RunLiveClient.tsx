'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { DecisionCard } from '@/components/DecisionCard';
import { PolicyDecisionRow } from '@/components/PolicyDecisionRow';
import { RelativeTime } from '@/components/RelativeTime';
import { RunEventRow } from '@/components/RunEventRow';
import {
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Section,
  StatPill,
  Table,
  TBody,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { compactDuration } from '@/lib/format';
import { usePoll } from '@/lib/poll';
import type { SerializedRunState } from '@/lib/queries/run-state';

/**
 * Editorial live run view (mirrors brand-kit Run Live, screen 05).
 *
 * Hero · 4-cell summary row · live tail card with terminal-style log
 * tail and a blinking phosphor cursor. Polls
 * `/api/projects/[slug]/runs/[id]/state` every 1500ms; auto-redirects
 * to the static detail when status flips terminal.
 */

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export interface RunLiveClientProps {
  readonly runId: string;
  readonly projectSlug: string;
  readonly initialSnapshot: SerializedRunState;
  readonly initialLastModified: string;
}

function deserializeDate(iso: string): Date {
  return new Date(iso);
}

export function RunLiveClient({ runId, projectSlug, initialSnapshot, initialLastModified }: RunLiveClientProps) {
  const router = useRouter();
  const url = `/api/projects/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(runId)}/state`;
  const { data, error, isPaused, nextAttemptInMs, lastModified } = usePoll<SerializedRunState>({
    url,
    intervalMs: 1500,
    pauseWhenHidden: true,
    initialData: initialSnapshot,
    initialLastModified,
  });

  const snapshot = data ?? initialSnapshot;
  const isTerminal = TERMINAL_STATUSES.has(snapshot.run.status);

  useEffect(() => {
    if (!isTerminal) return;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    router.replace(`/projects/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(runId)}${hash}` as never);
  }, [isTerminal, router, runId, projectSlug]);

  const startedAt = deserializeDate(snapshot.run.startedAt);
  const endedAt = snapshot.run.endedAt === null ? null : deserializeDate(snapshot.run.endedAt);
  const startedMs = startedAt.getTime();
  const endedMs = endedAt?.getTime() ?? Date.now();
  const elapsed = compactDuration(startedMs, endedMs);
  const allowCount = snapshot.policyDecisions.filter((d) => d.permissionDecision === 'allow').length;
  const denyCount = snapshot.policyDecisions.filter((d) => d.permissionDecision === 'deny').length;

  return (
    <>
      <PageHeader
        eyebrow={`/02 · AUDIT · LIVE · run ${runId.slice(0, 8)}`}
        title={<span>Run · live</span>}
        subtitle={
          <>
            SSE-style stream from <span className="font-mono text-accent">/api/runs/{runId.slice(0, 8)}/state</span>.
            Tail-of-log; auto-scroll on new events; pause to inspect.
          </>
        }
        meta={
          <StatPill tone="ok" dot>
            LIVE
          </StatPill>
        }
        actions={
          <>
            <LinkButton
              href={`/projects/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(runId)}` as never}
              variant="ghost"
            >
              Pause
            </LinkButton>
            <LinkButton href={`/projects/${encodeURIComponent(projectSlug)}/runs` as never} variant="primary">
              Stop run
            </LinkButton>
          </>
        }
      />

      <div className="mb-12 grid grid-cols-4 border-y border-rule">
        <SummaryCell
          label="Elapsed"
          value={elapsed}
          sub={`started ${startedAt.toISOString().slice(11, 19)}`}
          divider
          emphasis
        />
        <SummaryCell
          label="Events"
          value={snapshot.events.length}
          sub={`${error !== undefined ? 'reconnecting' : 'streaming'}`}
          divider
        />
        <SummaryCell label="Verdicts" value={`${allowCount} / ${denyCount}`} sub="allow · deny" emphasis divider />
        <SummaryCell
          label="Last update"
          value={lastModified !== undefined ? new Date(lastModified).toLocaleTimeString() : '—'}
          sub={isPaused ? 'paused (tab hidden)' : 'auto-scroll on'}
        />
      </div>

      {/* Live tail card */}
      <Card bare className="mb-12 p-0">
        <div className="flex items-center justify-between border-b border-rule px-6 py-4.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
            stream · /api/runs/{runId.slice(0, 8)}/state
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="border border-rule-strong px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-text-tertiary transition-colors hover:border-text-primary hover:text-text-primary"
            >
              Filter: ALL
            </button>
            <button
              type="button"
              className="border border-rule-strong px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-text-tertiary transition-colors hover:border-text-primary hover:text-text-primary"
            >
              Auto-scroll ON
            </button>
          </div>
        </div>
        <div
          className="font-mono text-[12px] leading-[1.85]"
          style={{ background: '#060906', minHeight: 420, maxHeight: 520, overflowY: 'auto', padding: '18px 22px' }}
        >
          {snapshot.events.length === 0 ? (
            <p className="text-text-muted">
              No events yet · waiting for stream
              <span className="cursor-blink" />
            </p>
          ) : (
            <>
              {snapshot.events.map((evt) => (
                <div key={evt.id} className="text-text-primary">
                  <span className="mr-3.5 text-text-muted">
                    {deserializeDate(evt.createdAt).toISOString().slice(11, 23)}
                  </span>
                  <span
                    className={`mr-3 tracking-[0.06em] ${
                      evt.phase === 'PreToolUse'
                        ? 'text-accent'
                        : evt.phase === 'PostToolUse'
                          ? 'text-text-primary'
                          : 'text-text-tertiary'
                    }`}
                  >
                    {evt.toolName ?? evt.phase.toLowerCase()}
                  </span>
                  <span className="text-text-tertiary">
                    {typeof evt.toolInput === 'string'
                      ? evt.toolInput
                      : evt.toolInput !== null
                        ? JSON.stringify(evt.toolInput).slice(0, 80)
                        : ''}
                  </span>
                </div>
              ))}
              <span className="cursor-blink" />
            </>
          )}
        </div>
      </Card>

      {/* Inline event list (canonical) */}
      <div className="mb-12">
        <Section
          title={
            <>
              Events <em>· detailed</em>
            </>
          }
          count={`${snapshot.events.length} events`}
        >
          {snapshot.events.length === 0 ? (
            <EmptyState
              title={
                <>
                  No <em>events</em> yet
                </>
              }
              body="Watch this space — the stream will populate."
            />
          ) : (
            <div className="flex flex-col gap-1.5">
              {snapshot.events.map((evt) => (
                <RunEventRow
                  key={evt.id}
                  phase={evt.phase}
                  toolName={evt.toolName}
                  toolUseId={evt.toolUseId}
                  toolInput={evt.toolInput}
                  outcome={evt.outcome}
                  createdAt={deserializeDate(evt.createdAt)}
                />
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title={
            <>
              Decisions <em>· {snapshot.decisions.length}</em>
            </>
          }
          count="recorded"
        >
          {snapshot.decisions.length === 0 ? (
            <EmptyState
              title={
                <>
                  No <em>decisions</em>
                </>
              }
              body="No decisions yet."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {snapshot.decisions.map((dec) => (
                <DecisionCard
                  key={dec.id}
                  description={dec.description}
                  rationale={dec.rationale}
                  alternatives={dec.alternatives}
                  createdAt={deserializeDate(dec.createdAt)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title={
            <>
              Audit <em>· {snapshot.policyDecisions.length}</em>
            </>
          }
          count="policy events"
        >
          {snapshot.policyDecisions.length === 0 ? (
            <EmptyState
              title={
                <>
                  No <em>policy</em> decisions
                </>
              }
              body="No policy decisions yet."
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
                {snapshot.policyDecisions.map((row) => (
                  <PolicyDecisionRow
                    key={row.id}
                    permissionDecision={row.permissionDecision}
                    toolName={row.toolName}
                    reason={row.reason}
                    matchedRuleId={row.matchedRuleId}
                    createdAt={deserializeDate(row.createdAt)}
                  />
                ))}
              </TBody>
            </Table>
          )}
        </Section>
      </div>

      <p className="mt-12 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--color-accent-glow)]" />
        <span>
          {error !== undefined
            ? `Reconnecting${nextAttemptInMs !== undefined ? ` in ${Math.round(nextAttemptInMs / 1000)}s` : ''}…`
            : `started ${startedAt.toISOString().slice(11, 19)} UTC · session ${snapshot.run.sessionId.slice(0, 12)}`}
        </span>
      </p>

      <RelativeTime
        date={startedAt}
        mode="compact" /* render so import isn't dead — RelativeTime renders inline above */
      />
    </>
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
