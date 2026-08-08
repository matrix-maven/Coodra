import type { ContextPackDetailRow } from '@coodra/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DetailTitle } from '@/components/DetailTitle';
import { Topbar } from '@/components/Topbar';
import { agentTypeLabel } from '@/lib/agent-label';
import { packsLinkingDecision } from '@/lib/context-pack-links';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { getContextPack } from '@/lib/queries/context-packs';
import { getDecision, listContextPacksForDecisions } from '@/lib/queries/decisions';

export const dynamic = 'force-dynamic';

/** `decisions.alternatives`/`.impact` are JSON-encoded string[] — best-effort parse, never throws on a legacy or malformed row. */
function parseStringArray(raw: string | null): ReadonlyArray<string> {
  if (raw === null || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [raw];
  }
}

export default async function DecisionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const decision = await getDecision(id);
  if (decision === null) notFound();

  const alternatives = parseStringArray(decision.alternatives);
  const impact = parseStringArray(decision.impact);

  // Usually 0 or 1 pack, not enforced — fetch each linking pack's FULL
  // body (not just the excerpt every other surface shows) since this is
  // the one page dedicated to a single decision's complete picture.
  const linkingPackIds = packsLinkingDecision(await listContextPacksForDecisions([decision]), decision.id).map(
    (p) => p.id,
  );
  const linkedPacks = (await Promise.all(linkingPackIds.map((packId) => getContextPack(packId)))).filter(
    (p): p is ContextPackDetailRow => p !== null,
  );

  const conf = decision.confidence ?? null;
  const confColor =
    conf === 'high'
      ? 'var(--accent)'
      : conf === 'low'
        ? 'var(--warn)'
        : conf === 'medium'
          ? 'var(--caution)'
          : 'var(--ink-mute)';

  return (
    <>
      <Topbar crumb={`decision · ${decision.id.slice(0, 8)}`} crumbPrefix="coodra / decisions" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · ACTION CENTER · DECISION {decision.id.slice(0, 8)}</div>
            <DetailTitle>{decision.description}</DetailTitle>
            <p className="head__lede">
              recorded {fmtClockSec(decision.createdAt)} ({fmtRelative(decision.createdAt)})
              {decision.projectSlug !== null ? (
                <>
                  {' · '}
                  <Link
                    href={`/projects/${encodeURIComponent(decision.projectSlug)}`}
                    style={{ color: 'var(--ink-dim)' }}
                  >
                    {decision.projectSlug}
                  </Link>
                </>
              ) : null}
              {decision.agentType !== null ? ` · ${agentTypeLabel(decision.agentType)}` : ''}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: confColor,
                border: `1px solid ${confColor}`,
                padding: '4px 10px',
                height: 'fit-content',
              }}
            >
              {conf ?? 'confidence —'}
            </span>
            {decision.reversible !== null ? (
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: decision.reversible ? 'var(--accent)' : 'var(--warn)',
                  border: `1px solid ${decision.reversible ? 'var(--accent)' : 'var(--warn)'}`,
                  padding: '4px 10px',
                  height: 'fit-content',
                }}
              >
                {decision.reversible ? 'reversible' : 'not reversible'}
              </span>
            ) : null}
          </div>
        </div>

        <div className="run-grid" style={runGrid}>
          <div>
            <div className="card" style={{ padding: 20, marginBottom: 24 }}>
              <SectionLabel>Rationale</SectionLabel>
              <p style={bodyText}>{decision.rationale}</p>
            </div>

            {decision.context !== null && decision.context.length > 0 ? (
              <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                <SectionLabel>What triggered this</SectionLabel>
                <p style={bodyText}>{decision.context}</p>
              </div>
            ) : null}

            {impact.length > 0 ? (
              <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                <SectionLabel>Impact</SectionLabel>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {impact.map((line) => (
                    <li key={line} style={{ ...bodyText, marginBottom: 6 }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {alternatives.length > 0 ? (
              <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                <SectionLabel>Alternatives considered</SectionLabel>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {alternatives.map((line) => (
                    <li key={line} style={{ ...bodyText, marginBottom: 6 }}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div>
            {decision.runId !== null ? (
              <div className="aside-card">
                <div className="aside-card__head">
                  <h3 className="aside-card__title">
                    Run <em>context</em>
                  </h3>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 12 }}>
                  This decision was recorded during a run — see the full event timeline, other decisions, and every
                  context pack from that session.
                </div>
                <Link className="btn btn--sm btn--accent" href={`/runs/${encodeURIComponent(decision.runId)}`}>
                  Open run · {decision.runId.slice(0, 8)} →
                </Link>
              </div>
            ) : null}

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Context <em>pack{linkedPacks.length === 1 ? '' : 's'}</em>
                </h3>
                <span className={`badge ${linkedPacks.length > 0 ? 'badge--ok' : ''}`}>
                  <span className="badge__dot"></span>
                  {linkedPacks.length > 0 ? linkedPacks.length : 'NONE'}
                </span>
              </div>
              {linkedPacks.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                  No context pack claimed this decision (legacy row, or the agent didn&apos;t link it on save).
                </div>
              ) : (
                linkedPacks.map((pack) => (
                  <div key={pack.id} style={{ marginBottom: 14 }}>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 400, marginBottom: 4 }}>
                      {pack.title}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--ink-mute)',
                        letterSpacing: '0.06em',
                        marginBottom: 8,
                      }}
                    >
                      {fmtRelative(pack.createdAt)}
                    </div>
                    <pre style={packPre}>{pack.content}</pre>
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

const bodyText: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: 'var(--ink)',
  margin: 0,
  whiteSpace: 'pre-wrap',
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
  maxHeight: 400,
};
