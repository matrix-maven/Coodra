import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DecisionItem } from '@/components/DecisionItem';
import { DetailTitle } from '@/components/DetailTitle';
import { Topbar } from '@/components/Topbar';
import { agentTypeLabel } from '@/lib/agent-label';
import { linkedDecisionIds } from '@/lib/context-pack-links';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { getContextPack } from '@/lib/queries/context-packs';
import { getRun } from '@/lib/queries/runs';
import { getWorkPackById } from '@/lib/queries/work-packs';

export const dynamic = 'force-dynamic';

export default async function ContextPackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const pack = await getContextPack(id);
  if (pack === null) notFound();

  const [run, workPack] = await Promise.all([
    getRun(pack.runId),
    pack.workPackId !== null ? getWorkPackById(pack.workPackId) : Promise.resolve(null),
  ]);
  const claimedIds = linkedDecisionIds(pack);
  const linkedDecisions = run?.decisions.filter((d) => claimedIds.has(d.id)) ?? [];
  // COOD-91 — "nothing claimed" and "claimed something that resolves to
  // nothing" are different states, and only the second is a bug. The old
  // copy hedged across both because the page could not tell them apart,
  // which is how three packs full of truncated ids went unnoticed.
  const unresolvedIds = [...claimedIds].filter((claimed) => !linkedDecisions.some((d) => d.id === claimed));

  return (
    <>
      <Topbar crumb={`pack · ${pack.id.slice(0, 8)}`} crumbPrefix="coodra / context-packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/04 · KNOWLEDGE · CONTEXT PACK {pack.id.slice(0, 8)}</div>
            <DetailTitle>{pack.title}</DetailTitle>
            <p className="head__lede">
              saved {fmtClockSec(pack.createdAt)} ({fmtRelative(pack.createdAt)})
              {pack.projectSlug !== null ? (
                <>
                  {' · '}
                  <Link href={`/projects/${encodeURIComponent(pack.projectSlug)}`} style={{ color: 'var(--ink-dim)' }}>
                    {pack.projectSlug}
                  </Link>
                </>
              ) : null}
              {pack.agentType !== null ? ` · ${agentTypeLabel(pack.agentType)}` : ''}
            </p>
          </div>
          <div>
            <span
              className={`badge ${pack.source === 'agent' ? 'badge--ok' : ''}`}
              title={
                pack.source === 'agent'
                  ? 'Agent-authored narrative via save_context_pack'
                  : 'Bridge auto-summary fallback (agent did not call save_context_pack)'
              }
            >
              <span className="badge__dot"></span>
              {pack.source === 'agent' ? 'AGENT-WRITTEN' : 'BRIDGE AUTO'}
            </span>
          </div>
        </div>

        <div className="run-grid" style={runGrid}>
          <div>
            <div className="card" style={{ padding: 20 }}>
              <SectionLabel>Full content</SectionLabel>
              <pre style={contentPre}>{pack.content}</pre>
            </div>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Run <em>context</em>
                </h3>
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 12 }}>
                This pack was saved during a run — see the full event timeline and every other pack from that session.
              </div>
              <Link className="btn btn--sm btn--accent" href={`/runs/${encodeURIComponent(pack.runId)}`}>
                Open run · {pack.runId.slice(0, 8)} →
              </Link>
            </div>

            {workPack !== null ? (
              <div className="aside-card">
                <div className="aside-card__head">
                  <h3 className="aside-card__title">
                    Work <em>pack</em>
                  </h3>
                  <span className="badge badge--ok">
                    <span className="badge__dot"></span>
                    {workPack.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 400, marginBottom: 8 }}>
                  {workPack.title}
                </div>
                <Link
                  className="btn btn--sm btn--ghost"
                  href={`/work-packs/${encodeURIComponent(workPack.projectSlug)}/${encodeURIComponent(workPack.slug)}`}
                >
                  Open {workPack.slug} →
                </Link>
              </div>
            ) : null}

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">Decisions</h3>
                <span className="card__role">{linkedDecisions.length} claimed</span>
              </div>
              {claimedIds.size === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                  This pack sets no{' '}
                  <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>meta.decisionIds</code> — either a
                  legacy row, or the agent recorded no decisions alongside it.
                </div>
              ) : (
                <>
                  {linkedDecisions.map((dec) => (
                    <DecisionItem key={dec.id} decision={dec} />
                  ))}
                  {unresolvedIds.length > 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, marginTop: 8 }}>
                      {unresolvedIds.length} claimed id
                      {unresolvedIds.length === 1 ? '' : 's'} did not resolve to a decision on this run:{' '}
                      {unresolvedIds.map((claimed, i) => (
                        <span key={claimed}>
                          {i > 0 ? ', ' : ''}
                          <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{claimed}</code>
                        </span>
                      ))}
                      . Usually a truncated id, or a decision recorded on a different run.
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

const runGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 380px',
  gap: 32,
  alignItems: 'start',
  marginTop: 32,
};

const contentPre: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '16px 18px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.7,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
};
