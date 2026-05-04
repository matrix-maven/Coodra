'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { DecisionCard } from '@/components/DecisionCard';
import { PolicyDecisionRow } from '@/components/PolicyDecisionRow';
import { RelativeTime } from '@/components/RelativeTime';
import { RunEventRow } from '@/components/RunEventRow';
import { RunStatusChip } from '@/components/RunStatusChip';
import { compactDuration } from '@/lib/format';
import { usePoll } from '@/lib/poll';
import type { SerializedRunState } from '@/lib/queries/run-state';

/**
 * Client-side live view of a run. Polls `/api/runs/[id]/state` every
 * 1500ms (per spec §8 + OQ-2). Auto-redirects to the static
 * `/runs/[id]` page when status flips to a terminal value.
 */

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export interface RunLiveClientProps {
  readonly runId: string;
  /** URL-decoded project slug — used to build static-detail href + API URL. */
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

  // Auto-redirect to the static detail page on terminal status.
  useEffect(() => {
    if (!isTerminal) return;
    // Preserve the active hash if any (e.g. #audit) so deep-link state survives.
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    router.replace(`/projects/${encodeURIComponent(projectSlug)}/runs/${encodeURIComponent(runId)}${hash}` as never);
  }, [isTerminal, router, runId, projectSlug]);

  const startedAt = deserializeDate(snapshot.run.startedAt);
  const endedAt = snapshot.run.endedAt === null ? null : deserializeDate(snapshot.run.endedAt);
  const startedMs = startedAt.getTime();
  const endedMs = endedAt?.getTime() ?? Date.now();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono text-3xl font-medium text-text-primary">{snapshot.run.id}</h1>
          <RunStatusChip status={snapshot.run.status} />
          <span className="ml-auto inline-flex items-center gap-2 border border-status-info/30 bg-status-info/10 px-2 py-1 text-xs font-medium text-status-info">
            <span className="streaming-pulse">●</span> Streaming
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-text-secondary">
          <span>
            Started <RelativeTime date={startedAt} mode="compact" />
          </span>
          {endedAt === null ? (
            <span>(running for {compactDuration(startedMs, endedMs)})</span>
          ) : (
            <span>
              Ended <RelativeTime date={endedAt} mode="compact" /> ({compactDuration(startedMs, endedMs)})
            </span>
          )}
          <span className="ml-auto font-mono text-text-tertiary">
            {error !== undefined ? (
              <span className="text-status-error">
                Reconnecting{nextAttemptInMs !== undefined ? ` in ${Math.round(nextAttemptInMs / 1000)}s` : ''}…
              </span>
            ) : isPaused ? (
              <span>Paused (tab hidden)</span>
            ) : (
              <span>Last updated {lastModified !== undefined ? new Date(lastModified).toLocaleTimeString() : '—'}</span>
            )}
          </span>
        </div>
      </header>

      <Section title={`Events (${snapshot.events.length})`}>
        {snapshot.events.length === 0 ? (
          <Empty hint="No events recorded yet. Watch this space." />
        ) : (
          <div className="border border-border-subtle">
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

      <Section title={`Decisions (${snapshot.decisions.length})`}>
        {snapshot.decisions.length === 0 ? (
          <Empty hint="No decisions yet." />
        ) : (
          <div className="flex flex-col gap-4">
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

      <Section title={`Audit (${snapshot.policyDecisions.length})`}>
        {snapshot.policyDecisions.length === 0 ? (
          <Empty hint="No policy decisions yet." />
        ) : (
          <table className="w-full border border-border-subtle">
            <thead className="bg-bg-elevated">
              <tr>
                <Th>Time</Th>
                <Th>Decision</Th>
                <Th>Tool</Th>
                <Th>Reason</Th>
                <Th>Matched rule</Th>
              </tr>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        )}
      </Section>

      <style jsx global>{`
        @keyframes streaming-pulse {
          0%,
          100% {
            opacity: 0.4;
          }
          50% {
            opacity: 1;
          }
        }
        .streaming-pulse {
          display: inline-block;
          animation: streaming-pulse 1.5s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-text-primary">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-border-subtle bg-bg-surface p-6 text-center text-sm text-text-tertiary">{hint}</div>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium text-text-secondary">{children}</th>;
}
