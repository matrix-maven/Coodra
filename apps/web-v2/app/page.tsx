import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { cancelAllInProgressRunsAction } from '@/lib/actions/runs';
import { fmtClock, fmtClockSec } from '@/lib/format';
import { type DecisionCapture, fetchDashboardSnapshot, type NarrativeCoverage } from '@/lib/queries/dashboard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    started?: string;
    stopped?: string;
    refreshed?: string;
    error?: string;
    errorMessage?: string;
    cleared?: string;
  }>;
}) {
  const sp = await searchParams;
  const snap = await fetchDashboardSnapshot();
  const totalDecisions = snap.allow24h + snap.denials24h;

  return (
    <>
      <Topbar crumb="Dashboard" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · WORKSPACE</div>
            <h1 className="head__title">
              Master the <em>context</em>.
            </h1>
            <p className="head__lede">
              Every run, every decision, every pack — local-first. Recorded, never reconstructed. Read-only by default.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{snap.totalRuns} runs total</strong>
              <br />
              {snap.activeRuns} active
              <br />
              {snap.mode} · v 0.4.1
            </div>
            <div className="head__actions">
              {snap.activeRuns > 0 ? (
                <form action={cancelAllInProgressRunsAction} style={{ display: 'inline' }}>
                  <input type="hidden" name="returnTo" value="/" />
                  <button
                    className="btn btn--ghost"
                    type="submit"
                    title="Force-complete every in_progress run (sets status=cancelled)"
                  >
                    Cancel {snap.activeRuns} stuck
                  </button>
                </form>
              ) : null}
              <Link className="btn btn--ghost" href="/sync">
                Audit queue
              </Link>
              <Link className="btn btn--accent" href="/init">
                New project
              </Link>
            </div>
          </div>
        </div>

        {sp.started !== undefined ? (
          <BannerStrip tone="ok">Services started · MCP + Hooks Bridge online.</BannerStrip>
        ) : null}
        {sp.stopped !== undefined ? <BannerStrip tone="ok">Services stopped.</BannerStrip> : null}
        {sp.cleared !== undefined ? (
          <BannerStrip tone="ok">
            Cleared {sp.cleared} stuck run{sp.cleared === '1' ? '' : 's'} · status=cancelled.
          </BannerStrip>
        ) : null}
        {sp.error !== undefined ? <BannerStrip tone="warn">{sp.errorMessage ?? sp.error}</BannerStrip> : null}

        <div className="stats">
          <div className="stat">
            <div className="stat__label">Active runs</div>
            <div className="stat__num">
              <Italic n={snap.activeRuns} />
            </div>
            <div className="stat__delta">{snap.totalRuns} total recorded</div>
          </div>
          <div className="stat">
            <div className="stat__label">Decisions · 24h</div>
            <div className="stat__num">{totalDecisions.toLocaleString()}</div>
            <div className="stat__delta">
              {snap.allow24h.toLocaleString()} allow · {snap.denials24h.toLocaleString()} deny
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Active switches</div>
            <div className="stat__num">{snap.activeKillSwitches === 0 ? <em>0</em> : snap.activeKillSwitches}</div>
            <div className="stat__delta">{snap.activeKillSwitches === 0 ? 'No paused agents' : 'Agents paused'}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Mode</div>
            <div className="stat__num" style={{ fontSize: 32 }}>
              {snap.mode}
            </div>
            <div className="stat__delta">{snap.mode === 'solo' ? '~/.contextos/data.db' : 'cloud postgres'}</div>
          </div>
        </div>

        {/* Module 05 §6.E — Agent narrative coverage + decision capture.
            Two coverage metrics surfaced side-by-side because they measure
            different agent disciplines: pack saving (end-of-session
            narrative) vs. decision recording (mid-session structured
            intent). Either dropping is a signal to investigate. */}
        <CoverageStrips narrative={snap.narrativeCoverage7d} decisions={snap.decisionCapture30d} />

        <div className="dash-grid">
          <div>
            <div className="card__head" style={{ marginBottom: 16 }}>
              <h2 className="card__title">
                Recent <em>runs</em>
              </h2>
              <span className="card__role">last 24h · all projects</span>
            </div>
            <div className="dash-list">
              {snap.latestRuns.length === 0 ? (
                <div className="empty">
                  <strong>
                    No runs <em>yet</em>.
                  </strong>
                  Trigger a session from any agent and the trace lands here in real-time.
                </div>
              ) : (
                snap.latestRuns.map((run) => {
                  const verdict = (() => {
                    if (run.status === 'in_progress') return { label: 'RUNNING', cls: 'row__verdict--running' };
                    if (run.status === 'cancelled') return { label: 'CANCELLED', cls: 'row__verdict--deny' };
                    if (run.status === 'completed') return { label: 'COMPLETE', cls: '' };
                    return { label: run.status.toUpperCase(), cls: '' };
                  })();
                  const dotCls =
                    run.status === 'in_progress' ? 'row__dot--w' : run.status === 'cancelled' ? 'row__dot--warn' : '';
                  return (
                    <div key={run.id} className="row">
                      <div className={`row__dot ${dotCls}`}></div>
                      <div className="row__main">
                        <div className="row__title">
                          {run.agentType} · <em>{run.sessionId.slice(0, 12)}</em>
                        </div>
                        <div className="row__sub">
                          run · {run.id.slice(0, 8)} · started {fmtClockSec(run.startedAt)}
                        </div>
                      </div>
                      <div className={`row__verdict ${verdict.cls}`}>{verdict.label}</div>
                      <div className="row__time">{fmtClock(run.startedAt)}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Latest <em>events</em>
                </h3>
                <span className="card__role">stream · 8</span>
              </div>
              {snap.latestEvents.length === 0 ? (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--ink-mute)',
                    letterSpacing: '0.05em',
                    padding: '24px 0',
                    textAlign: 'center',
                  }}
                >
                  No events recorded.
                </div>
              ) : (
                snap.latestEvents.map((ev, i) => {
                  const isDeny = ev.outcome === 'deny';
                  const dotCls = isDeny ? 'event__dot--warn' : ev.phase === 'PostToolUse' ? 'event__dot--w' : '';
                  return (
                    <div key={ev.id} className="event" style={i === 0 ? undefined : { marginTop: 6 }}>
                      <div className={`event__dot ${dotCls}`}></div>
                      <div className="event__time">{fmtClockSec(ev.createdAt)}</div>
                      <div className="event__tool">
                        {ev.phase} · <b>{ev.toolName}</b>
                      </div>
                      <div></div>
                      <div className={`event__verdict ${isDeny ? 'event__verdict--deny' : ''}`}>
                        {(ev.outcome ?? 'allow').toUpperCase()}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  System <em>state</em>
                </h3>
                <span className="badge badge--ok">
                  <span className="badge__dot"></span>HEALTHY
                </span>
              </div>
              <SystemRow title="MCP server" sub="127.0.0.1:3100 · stdio + http" tone="ok" />
              <SystemRow title="Hooks bridge" sub="127.0.0.1:3101 · 4 handlers" tone="ok" />
              <SystemRow
                title="Sync daemon"
                sub={snap.mode === 'solo' ? 'standby · solo' : 'queue depth · 0'}
                tone={snap.mode === 'solo' ? 'idle' : 'ok'}
              />
              <SystemRow
                title="Storage"
                sub={snap.mode === 'solo' ? '~/.contextos/data.db' : 'cloud postgres'}
                tone="ok"
                last
              />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Italic({ n }: { n: number }) {
  // Numbers <100 render with serif italic accent for editorial feel.
  if (n < 100) return <em>{n}</em>;
  return <>{n.toLocaleString()}</>;
}

/**
 * Coverage strips — narrative + decision side-by-side.
 *
 * Module 05 §6.E surface (narrative) plus the decision-capture
 * counterpart (added 2026-05-08). Two distinct disciplines:
 *   - Narrative: agent calls save_context_pack at session end
 *   - Decision : agent calls record_decision mid-session
 * Either dropping signals a different agent-compliance regression.
 */
function CoverageStrips({ narrative, decisions }: { narrative: NarrativeCoverage; decisions: DecisionCapture }) {
  return (
    <div
      style={{
        marginBottom: 32,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
        gap: 16,
      }}
    >
      <CoverageCell
        title="Agent narrative coverage · 7d"
        ratio={narrative.ratio}
        numerator={narrative.agentAuthoredPacks}
        denominator={narrative.totalPacks}
        denominatorLabel="Context Packs"
        emptyHint="No Context Packs recorded in the last 7 days. Run an agent session and the dashboard populates."
        explainerOk={
          <>
            agent-authored. The remainder are bridge auto-summaries — useful as a floor, but agents that call{' '}
            <code style={inlineMono}>save_context_pack</code> produce richer narrative for the next session.
          </>
        }
        explainerLow={
          <>
            agents skipping <code style={inlineMono}>save_context_pack</code>. Bridge fallback is doing the work; check{' '}
            <Link href="/context-packs?source=bridge_auto" style={{ color: 'var(--ink)' }}>
              recent auto-saves
            </Link>{' '}
            to see what's missing.
          </>
        }
      />
      <CoverageCell
        title="Decisions captured · 30d"
        ratio={decisions.ratio}
        numerator={decisions.runsWithDecision}
        denominator={decisions.totalCompletedRuns}
        denominatorLabel="completed runs"
        emptyHint="No completed runs in the last 30 days. The decision-capture metric needs runs to measure against."
        explainerOk={
          <>
            recorded at least one decision via <code style={inlineMono}>record_decision</code>. Healthy: the agent is
            logging structured intent mid-session, not just at the end.
          </>
        }
        explainerLow={
          <>
            recorded a decision. The agent is closing sessions without logging architectural intent — future runs will
            silently contradict prior choices. Manifest descriptions + SessionStart contract should push this up.
          </>
        }
      />
    </div>
  );
}

function CoverageCell({
  title,
  ratio,
  numerator,
  denominator,
  denominatorLabel,
  emptyHint,
  explainerOk,
  explainerLow,
}: {
  title: string;
  ratio: number | null;
  numerator: number;
  denominator: number;
  denominatorLabel: string;
  emptyHint: React.ReactNode;
  explainerOk: React.ReactNode;
  explainerLow: React.ReactNode;
}) {
  const hasData = ratio !== null;
  const pct = hasData ? Math.round(ratio * 100) : null;
  const tone = !hasData
    ? { fg: 'var(--ink-mute)', glow: 'transparent', label: 'NO DATA' }
    : pct! >= 80
      ? { fg: 'var(--accent)', glow: 'var(--accent-glow)', label: 'HEALTHY' }
      : pct! >= 50
        ? { fg: 'var(--caution)', glow: 'var(--caution-glow)', label: 'WATCH' }
        : { fg: 'var(--warn)', glow: 'var(--warn-glow)', label: 'LOW' };
  return (
    <div
      style={{
        padding: '20px 24px',
        border: `1px solid ${tone.fg}`,
        background: tone.glow,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 140 }}>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--ink-mute)',
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 48, color: tone.fg, fontWeight: 400 }}>
            {hasData ? `${pct}%` : '—'}
          </span>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.18em',
              color: tone.fg,
            }}
          >
            {tone.label}
          </span>
        </div>
      </div>
      <div style={{ flex: 1, fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, minWidth: 220 }}>
        {hasData ? (
          <>
            <strong style={{ color: 'var(--ink)' }}>{numerator}</strong> of{' '}
            <strong style={{ color: 'var(--ink)' }}>{denominator}</strong> {denominatorLabel}{' '}
            {pct! >= 50 ? explainerOk : explainerLow}
          </>
        ) : (
          emptyHint
        )}
      </div>
    </div>
  );
}

const inlineMono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--accent)',
};

function BannerStrip({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
}

function SystemRow({
  title,
  sub,
  tone,
  last,
}: {
  title: string;
  sub: string;
  tone: 'ok' | 'idle' | 'warn';
  last?: boolean;
}) {
  const dotCls = tone === 'idle' ? 'row__dot--w' : tone === 'warn' ? 'row__dot--warn' : '';
  return (
    <div
      className="row"
      style={{
        background: 'transparent',
        padding: '12px 0',
        border: 'none',
        borderBottom: last ? 'none' : '1px solid var(--rule)',
      }}
    >
      <div className={`row__dot ${dotCls}`}></div>
      <div className="row__main">
        <div style={{ fontSize: 14 }}>{title}</div>
        <div className="row__sub">{sub}</div>
      </div>
    </div>
  );
}
