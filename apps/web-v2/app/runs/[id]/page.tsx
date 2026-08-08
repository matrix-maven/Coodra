import { notFound } from 'next/navigation';

import { DecisionItem } from '@/components/DecisionItem';
import { Topbar } from '@/components/Topbar';
import { cancelRunAction } from '@/lib/actions/runs';
import { agentTypeLabel } from '@/lib/agent-label';
import { groupDecisionsByPack } from '@/lib/context-pack-links';
import { compactDuration, fmtClockSec, fmtRelative } from '@/lib/format';
import { getRun, getRunLastActivity } from '@/lib/queries/runs';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cancelled?: string; noop?: string; error?: string }>;
}) {
  const { id: rawId } = await params;
  const sp = await searchParams;
  const id = decodeURIComponent(rawId);
  const [snapshot, lastActivity] = await Promise.all([getRun(id), getRunLastActivity(id)]);
  if (snapshot === null) notFound();

  const { run, events, decisions, policyDecisions, contextPacks } = snapshot;
  const allowCount = policyDecisions.filter((p) => p.permissionDecision === 'allow').length;
  const denyCount = policyDecisions.filter((p) => p.permissionDecision === 'deny').length;

  // Most-recent pack first for the sidebar; each pack's own linked
  // decisions render underneath it (populated from `meta.decisionIds`
  // when the agent set it on save). Decisions with no linking pack
  // (legacy rows, or the agent didn't tag them) fall into a trailing
  // "Other decisions" bucket rather than vanishing.
  const { packsWithDecisions, otherDecisions } = groupDecisionsByPack([...contextPacks].reverse(), decisions);

  const durationLabel =
    run.endedAt === null
      ? compactDuration(run.startedAt.getTime(), Date.now())
      : compactDuration(run.startedAt.getTime(), run.endedAt.getTime());
  const isLive = run.status === 'in_progress';

  return (
    <>
      <Topbar crumb={`run · ${run.id.slice(0, 8)}`} crumbPrefix="coodra / runs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · ACTION CENTER · RUN {run.id.slice(0, 8)}</div>
            <h1 className="head__title">
              {agentTypeLabel(run.agentType)} · <em>{run.sessionId.slice(0, 14)}</em>
            </h1>
            <p className="head__lede">
              session <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink-dim)' }}>{run.sessionId}</span> ·
              started {fmtClockSec(run.startedAt)}
              {run.endedAt === null ? '' : ` · ended ${fmtClockSec(run.endedAt)}`}
              {lastActivity === null ? '' : ` · updated ${fmtClockSec(lastActivity)} (${fmtRelative(lastActivity)})`}
              {contextPacks.length === 0 ? (
                ''
              ) : (
                <>
                  {' · '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                    {contextPacks.length} pack{contextPacks.length === 1 ? '' : 's'}
                  </span>
                </>
              )}
            </p>
          </div>
          <div>
            <span
              className={`badge ${isLive ? 'badge--caution' : run.status === 'cancelled' ? 'badge--warn' : 'badge--ok'}`}
            >
              <span className="badge__dot"></span>
              {run.status.toUpperCase()}
            </span>
            <div style={{ display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end' }}>
              <a className="btn btn--sm btn--ghost" href={`/runs/${run.id}/diff`}>
                View diff →
              </a>
              {isLive ? (
                <>
                  <a className="btn btn--sm btn--accent" href={`/runs/${run.id}/live`}>
                    Live tail →
                  </a>
                  <form action={cancelRunAction} style={{ display: 'inline' }}>
                    <input type="hidden" name="id" value={run.id} />
                    <input type="hidden" name="returnTo" value={`/runs/${run.id}`} />
                    <button className="btn btn--sm btn--ghost" type="submit" title="Force-complete this stuck run">
                      Force complete
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {sp.cancelled !== undefined ? (
          <div className="banner banner--ok">Run cancelled · {sp.cancelled.slice(0, 8)}</div>
        ) : null}
        {sp.noop !== undefined ? <div className="banner">Already terminal — no change</div> : null}
        {sp.error !== undefined ? <div className="banner banner--warn">Error: {sp.error}</div> : null}

        <div className="run-summary" style={summaryGrid}>
          <Cell label="Duration" value={durationLabel} sub={`${fmtRelative(run.startedAt)} → now`} />
          <Cell label="Events" value={String(events.length)} sub={summarizeEvents(events)} />
          <Cell label="Decisions" value={`${allowCount + denyCount}`} sub={`${allowCount} allow · ${denyCount} deny`} />
          <Cell label="Mode" value={run.mode} sub={`${agentTypeLabel(run.agentType)} · ${run.id.slice(0, 8)}`} />
        </div>

        <div className="run-grid" style={runGrid}>
          <div>
            <div className="card__head" style={{ marginBottom: 16 }}>
              <h2 className="card__title">
                Event <em>timeline</em>
              </h2>
              <span className="card__role">{events.length} events · chronological</span>
            </div>
            {events.length === 0 ? (
              <div className="empty">
                <strong>
                  No events <em>yet</em>.
                </strong>
                The first PreToolUse / PostToolUse from this run will appear here.
              </div>
            ) : (
              events.map((evt) => {
                const isPost = evt.phase === 'PostToolUse';
                const dotCls = isPost ? 'event__dot--w' : '';
                return (
                  <div key={evt.id} className="event">
                    <div className={`event__dot ${dotCls}`}></div>
                    <div className="event__time">{fmtClockSec(evt.createdAt)}</div>
                    <div className="event__tool">
                      {evt.phase} · <b>{evt.toolName}</b>
                    </div>
                    <div className="event__dur">{evt.toolUseId.slice(0, 8)}</div>
                    <div className={`event__verdict ${evt.outcome === 'deny' ? 'event__verdict--deny' : ''}`}>
                      {(evt.outcome ?? 'allow').toUpperCase()}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div>
            {packsWithDecisions.length === 0 ? (
              <div className="aside-card">
                <div className="aside-card__head">
                  <h3 className="aside-card__title">
                    Context <em>packs</em>
                  </h3>
                  <span className="badge">
                    <span className="badge__dot"></span>NONE
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                  No pack written for this run yet. Auto-pack fires on SessionEnd.
                </div>
              </div>
            ) : (
              // One card per pack, newest first — a run can accumulate
              // several across distinct pieces of work (2026-08-08 fix;
              // this used to silently show only one, arbitrarily chosen).
              // Each pack's own linked decisions (meta.decisionIds) render
              // right under its excerpt, so the "which decisions belong to
              // which piece of work" grouping that was missing is visible.
              packsWithDecisions.map(({ pack, linked }) => (
                <div className="aside-card" key={pack.id}>
                  <div className="aside-card__head">
                    <h3 className="aside-card__title">
                      Context <em>pack</em>
                    </h3>
                    <span className="badge badge--ok">
                      <span className="badge__dot"></span>LANDED
                    </span>
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 400, marginBottom: 6 }}>
                      {pack.title}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--ink-mute)',
                        letterSpacing: '0.06em',
                      }}
                    >
                      {fmtRelative(pack.createdAt)}
                    </div>
                  </div>
                  <pre style={packPre}>{pack.contentExcerpt}</pre>
                  {linked.length > 0 ? (
                    <div style={{ marginTop: 14 }}>
                      {linked.map((dec) => (
                        <DecisionItem key={dec.id} decision={dec} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  {packsWithDecisions.length === 0 ? 'Decisions' : 'Other decisions'}
                </h3>
                <span className="card__role">{otherDecisions.length} recorded</span>
              </div>
              {otherDecisions.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                  {packsWithDecisions.length === 0 ? 'No decisions recorded.' : 'None outside a context pack above.'}
                </div>
              ) : (
                otherDecisions.map((dec) => <DecisionItem key={dec.id} decision={dec} />)
              )}
            </div>

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Policy <em>decisions</em>
                </h3>
                <span className="card__role">{policyDecisions.length}</span>
              </div>
              {policyDecisions.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>None recorded.</div>
              ) : (
                policyDecisions.slice(0, 6).map((pd) => (
                  <div key={pd.id} className="event" style={{ marginBottom: 6 }}>
                    <div className={`event__dot ${pd.permissionDecision === 'deny' ? 'event__dot--warn' : ''}`}></div>
                    <div className="event__time">{fmtClockSec(pd.createdAt)}</div>
                    <div className="event__tool">{pd.toolName}</div>
                    <div></div>
                    <div className={`event__verdict ${pd.permissionDecision === 'deny' ? 'event__verdict--deny' : ''}`}>
                      {pd.permissionDecision.toUpperCase()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const summaryGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  borderTop: '1px solid var(--rule)',
  borderBottom: '1px solid var(--rule)',
  marginBottom: 32,
};

const runGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 380px',
  gap: 32,
  alignItems: 'start',
};

const packPre: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '14px 16px',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  lineHeight: 1.7,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
  maxHeight: 280,
};

function Cell({ label, value, sub }: { label: string; value: string; sub: string }) {
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
        style={{
          fontFamily: 'var(--serif)',
          fontSize: 36,
          fontWeight: 400,
          letterSpacing: '-0.01em',
          lineHeight: 1,
        }}
      >
        {value}
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

function summarizeEvents(events: ReadonlyArray<{ toolName: string }>): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.toolName, (counts.get(e.toolName) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.map(([k, v]) => `${k} ${v}`).join(' · ');
}
