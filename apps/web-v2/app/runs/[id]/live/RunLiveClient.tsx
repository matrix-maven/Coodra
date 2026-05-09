'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Topbar } from '@/components/Topbar';
import { compactDuration, fmtClockSec, fmtRelative } from '@/lib/format';
import { usePoll } from '@/lib/poll';
import type { SerializedRunState } from '@/lib/queries/run-state';

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export interface RunLiveClientProps {
  readonly runId: string;
  readonly initialSnapshot: SerializedRunState;
  readonly initialLastModified: string;
}

function deserializeDate(iso: string): Date {
  return new Date(iso);
}

export function RunLiveClient({ runId, initialSnapshot, initialLastModified }: RunLiveClientProps) {
  const router = useRouter();
  const url = `/api/runs/${encodeURIComponent(runId)}/state`;
  const { data, error, isPaused, nextAttemptInMs, lastModified } = usePoll<SerializedRunState>({
    url,
    intervalMs: 1500,
    pauseWhenHidden: true,
    initialData: initialSnapshot,
    initialLastModified,
  });

  const snapshot = data ?? initialSnapshot;
  const isTerminal = TERMINAL_STATUSES.has(snapshot.run.status);

  // Auto-redirect to the static detail when the run finishes.
  useEffect(() => {
    if (!isTerminal) return;
    router.replace(`/runs/${encodeURIComponent(runId)}`);
  }, [isTerminal, router, runId]);

  const startedAt = deserializeDate(snapshot.run.startedAt);
  const endedAt = snapshot.run.endedAt === null ? null : deserializeDate(snapshot.run.endedAt);
  const startedMs = startedAt.getTime();

  // SSR vs. client hydration mismatch fix: the elapsed counter for an
  // in-progress run depends on `Date.now()` at render time. The server
  // computes one timestamp at SSR; the client mounts ~1s later and
  // computes another → "2m 22s" vs "2m 21s" hydration warning. The
  // fix is to anchor the "now" value in component state, initialise
  // it to `startedMs` (so first-paint elapsed is always "0s") and let
  // a 1Hz interval tick it up after mount. Server and client agree on
  // the initial render; the live tick is a normal post-mount effect.
  const [now, setNow] = useState<number>(startedMs);
  useEffect(() => {
    if (endedAt !== null) {
      // Run is terminal — freeze the counter at endedAt.
      setNow(endedAt.getTime());
      return undefined;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endedAt]);

  const endedMs = endedAt?.getTime() ?? now;
  const elapsed = compactDuration(startedMs, endedMs);
  const allowCount = snapshot.policyDecisions.filter((d) => d.permissionDecision === 'allow').length;
  const denyCount = snapshot.policyDecisions.filter((d) => d.permissionDecision === 'deny').length;

  // Auto-scroll the log tail when new events arrive.
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tailRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot.events.length]);

  return (
    <>
      <Topbar crumb={`live · ${runId.slice(0, 8)}`} crumbPrefix="contextos / runs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · AUDIT · LIVE · run {runId.slice(0, 8)}</div>
            <h1 className="head__title">
              {snapshot.run.agentType} · <em>{snapshot.run.sessionId.slice(0, 14)}</em>
            </h1>
            <p className="head__lede">
              SSE-style poll from <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{url}</span>.
              Tail-of-log; auto-scrolls on new events; pauses when the tab is hidden.
            </p>
          </div>
          <div>
            <span className="badge badge--ok">
              <span className="badge__dot"></span>
              {isTerminal ? snapshot.run.status.toUpperCase() : isPaused ? 'PAUSED' : 'LIVE'}
            </span>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/runs/${encodeURIComponent(runId)}`}>
                Open detail
              </Link>
              <Link className="btn" href="/runs">
                All runs
              </Link>
            </div>
          </div>
        </div>

        <div
          className="run-summary"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            borderTop: '1px solid var(--rule)',
            borderBottom: '1px solid var(--rule)',
            marginBottom: 32,
          }}
        >
          <Cell label="Elapsed" value={elapsed} sub={`started ${fmtClockSec(startedAt)}`} emphasis />
          <Cell
            label="Events"
            value={String(snapshot.events.length)}
            sub={error !== undefined ? 'reconnecting…' : isPaused ? 'paused' : 'streaming'}
          />
          <Cell label="Verdicts" value={`${allowCount} / ${denyCount}`} sub="allow · deny" emphasis />
          <Cell
            label="Last update"
            value={lastModified !== undefined ? new Date(lastModified).toLocaleTimeString() : '—'}
            sub={
              error !== undefined && nextAttemptInMs !== undefined
                ? `retry in ${Math.round(nextAttemptInMs / 1000)}s`
                : 'auto-scroll on'
            }
          />
        </div>

        <div className="card" style={{ padding: 0, marginBottom: 32 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '18px 24px',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-dim)',
              }}
            >
              stream · {url}
            </span>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: error !== undefined ? 'var(--warn)' : 'var(--accent)',
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
              }}
            >
              {error !== undefined ? '● disconnected' : isPaused ? '● paused' : '● live'}
            </span>
          </div>
          <div
            ref={tailRef}
            style={{
              background: '#060906',
              minHeight: 420,
              maxHeight: 520,
              overflowY: 'auto',
              padding: '18px 22px',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              lineHeight: 1.85,
            }}
          >
            {snapshot.events.length === 0 ? (
              <div style={{ color: 'var(--ink-mute)' }}>
                waiting for first event<span style={cursorStyle}></span>
              </div>
            ) : (
              <>
                {snapshot.events.map((evt) => (
                  <div key={evt.id} style={{ color: 'var(--ink)' }}>
                    <span style={{ color: 'var(--ink-mute)', marginRight: 14 }}>
                      {fmtClockSec(deserializeDate(evt.createdAt))}
                    </span>
                    <span
                      style={{
                        color:
                          evt.outcome === 'deny'
                            ? 'var(--warn)'
                            : evt.phase === 'PreToolUse'
                              ? 'var(--accent)'
                              : 'var(--ink)',
                        marginRight: 12,
                        letterSpacing: '0.06em',
                      }}
                    >
                      {evt.toolName}
                    </span>
                    <span style={{ color: 'var(--ink-dim)' }}>
                      {evt.phase} · {evt.toolUseId.slice(0, 8)} · {(evt.outcome ?? 'allow').toUpperCase()}
                    </span>
                  </div>
                ))}
                <div style={{ color: 'var(--accent)' }}>
                  <span style={cursorStyle}></span>
                </div>
              </>
            )}
          </div>
        </div>

        {snapshot.policyDecisions.length > 0 ? (
          <div className="aside-card">
            <div className="aside-card__head">
              <h3 className="aside-card__title">
                Policy <em>decisions</em>
              </h3>
              <span className="card__role">{snapshot.policyDecisions.length}</span>
            </div>
            {snapshot.policyDecisions.slice(0, 8).map((pd, i) => (
              <div key={pd.id} className="event" style={i === 0 ? undefined : { marginTop: 6 }}>
                <div className={`event__dot ${pd.permissionDecision === 'deny' ? 'event__dot--warn' : ''}`}></div>
                <div className="event__time">{fmtClockSec(deserializeDate(pd.createdAt))}</div>
                <div className="event__tool">{pd.toolName}</div>
                <div className="event__dur">{fmtRelative(deserializeDate(pd.createdAt))}</div>
                <div className={`event__verdict ${pd.permissionDecision === 'deny' ? 'event__verdict--deny' : ''}`}>
                  {pd.permissionDecision.toUpperCase()}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <style>{`@keyframes cos-blink { 50% { opacity: 0; } }`}</style>
    </>
  );
}

const cursorStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 8,
  height: 14,
  background: 'var(--accent)',
  verticalAlign: -2,
  marginLeft: 4,
  animation: 'cos-blink 1s steps(2) infinite',
};

function Cell({ label, value, sub, emphasis }: { label: string; value: string; sub: string; emphasis?: boolean }) {
  return (
    <div style={{ padding: '24px 0 24px', paddingRight: 24, borderRight: '1px solid var(--rule)' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        style={{ fontFamily: 'var(--serif)', fontSize: 36, fontWeight: 400, letterSpacing: '-0.01em', lineHeight: 1 }}
      >
        {emphasis ? <em style={{ color: 'var(--accent)' }}>{value}</em> : value}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          marginTop: 8,
          letterSpacing: '0.06em',
        }}
      >
        {sub}
      </div>
    </div>
  );
}
