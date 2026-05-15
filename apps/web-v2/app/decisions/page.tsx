import Link from 'next/link';

import { ActorBadge } from '@/components/ActorBadge';
import { Topbar } from '@/components/Topbar';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { resolveClerkDisplayNames } from '@/lib/queries/clerk-users';
import { listDecisions } from '@/lib/queries/decisions';
import { listProjects } from '@/lib/queries/projects';
import { readTeamConfig } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly project?: string;
  readonly limit?: string;
}

/**
 * `/decisions` — workspace-wide decisions browser.
 *
 * Pre-cleanup the agent could record decisions via
 * `coodra__record_decision` and query them via
 * `coodra__query_decisions`, but the web app only surfaced them
 * per-run (on `/runs/[id]`). Operators trying to answer "what's the
 * trail of architectural decisions across this whole workspace?"
 * had to grep the SQLite DB. This page closes the gap.
 *
 * Filterable by project via `?project=<slug>`. Default limit 100.
 */
export default async function DecisionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const projects = await listProjects();
  const projectMap = new Map(projects.map((p) => [p.slug, p]));
  const selectedProject = sp.project !== undefined && sp.project !== '' ? projectMap.get(sp.project) : undefined;
  const limit = clampLimit(sp.limit);
  const decisions = await listDecisions({
    ...(selectedProject !== undefined ? { projectId: selectedProject.id } : {}),
    limit,
  });

  // Team-mode "decided by" attribution: show the viewer's own writes as
  // "You", other teammates by their resolved name / email (via Clerk).
  // In solo mode no row carries a created_by_user_id so the column
  // collapses into em-dashes — we hide it then to save horizontal space.
  const teamCfg = readTeamConfig();
  const viewerUserId = teamCfg.mode === 'team' ? teamCfg.team?.clerkUserId ?? null : null;
  const showAuthorColumn = teamCfg.mode === 'team' || decisions.some((d) => d.createdByUserId !== null);
  // Batch-resolve every distinct Clerk user id on the page to a display
  // name (full name → email → shortened id fallback). Solo mode skips
  // the Clerk round-trip because there's no team config to authenticate.
  const userDisplayNames = showAuthorColumn && teamCfg.mode === 'team'
    ? await resolveClerkDisplayNames(decisions.map((d) => d.createdByUserId))
    : new Map<string, { label: string; email: string | null }>();

  return (
    <>
      <Topbar
        crumb="Decisions"
        crumbPrefix={selectedProject !== undefined ? `coodra / ${selectedProject.slug}` : 'coodra'}
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /02 · AUDIT · DECISIONS
              {selectedProject !== undefined ? ` · ${selectedProject.slug.toUpperCase()}` : ''}
            </div>
            <h1 className="head__title">
              Every <em>decision</em>, recorded.
            </h1>
            <p className="head__lede">
              Each row is a deliberate architectural or implementation choice the agent recorded mid-session via{' '}
              <code style={mono}>coodra__record_decision</code>. Future sessions consult this list — and SessionStart
              auto-injects the most recent — so silent contradictions don&apos;t happen.
              {selectedProject !== undefined ? (
                <>
                  {' Scoped to '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{selectedProject.slug}</span>
                  {' — '}
                  <Link href="/decisions" style={{ textDecoration: 'underline', color: 'var(--ink-dim)' }}>
                    show all
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{decisions.length} decisions</strong>
              <br />
              {decisions.length === limit ? `more than ${limit}` : 'showing all'}
              <br />
              {selectedProject !== undefined ? selectedProject.slug : `${projects.length} projects`}
            </div>
          </div>
        </div>

        {/* Filter bar */}
        <form
          method="get"
          style={{
            display: 'flex',
            gap: 16,
            marginBottom: 32,
            flexWrap: 'wrap',
            alignItems: 'center',
            padding: '16px 20px',
            border: '1px solid var(--rule)',
            background: 'var(--bg-2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={filterLabel}>Project</span>
            <select name="project" defaultValue={selectedProject?.slug ?? ''} style={selectStyle}>
              <option value="">— all projects —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.slug}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn--sm" type="submit" style={{ marginLeft: 'auto' }}>
            Apply
          </button>
        </form>

        {decisions.length === 0 ? (
          <div className="empty">
            <strong>
              No decisions <em>yet</em>.
            </strong>
            The agent records decisions via <code style={mono}>coodra__record_decision</code>. They&apos;ll appear
            here as they&apos;re made.
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 18 }}></th>
                  <th>Decision</th>
                  <th>Project</th>
                  {showAuthorColumn ? <th>Decided by</th> : null}
                  <th>Confidence</th>
                  <th>Rev?</th>
                  <th style={{ textAlign: 'right' }}>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => {
                  const conf = d.confidence ?? null;
                  const confColor =
                    conf === 'high'
                      ? 'var(--accent)'
                      : conf === 'low'
                        ? 'var(--warn)'
                        : conf === 'medium'
                          ? 'var(--caution)'
                          : 'var(--ink-mute)';
                  return (
                    <tr key={d.id}>
                      <td>
                        <span className="row__dot" style={{ background: confColor }} />
                      </td>
                      <td style={{ maxWidth: 540 }}>
                        <div className="tbl__title">{d.description}</div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--ink-dim)',
                            lineHeight: 1.5,
                            marginTop: 4,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {d.rationale}
                        </div>
                        {d.context !== null && d.context.length > 0 ? (
                          <div
                            style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 10,
                              color: 'var(--ink-mute)',
                              letterSpacing: '0.04em',
                              marginTop: 6,
                            }}
                          >
                            CONTEXT · {d.context.slice(0, 120)}
                            {d.context.length > 120 ? '…' : ''}
                          </div>
                        ) : null}
                      </td>
                      <td className="tbl__mono">
                        {d.projectSlug !== null ? (
                          <Link
                            href={`/projects/${encodeURIComponent(d.projectSlug)}`}
                            style={{ color: 'var(--ink-dim)' }}
                          >
                            {d.projectSlug}
                          </Link>
                        ) : (
                          <span style={{ color: 'var(--ink-mute)' }}>—</span>
                        )}
                      </td>
                      {showAuthorColumn ? (
                        <td>
                          <ActorBadge
                            userId={d.createdByUserId}
                            viewerUserId={viewerUserId}
                            {...((d.createdByUserId !== null && userDisplayNames.get(d.createdByUserId)?.label) !== undefined
                              ? { displayName: userDisplayNames.get(d.createdByUserId as string)!.label }
                              : {})}
                          />
                        </td>
                      ) : null}
                      <td>
                        <span
                          style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 10,
                            letterSpacing: '0.18em',
                            textTransform: 'uppercase',
                            color: confColor,
                          }}
                        >
                          {conf ?? '—'}
                        </span>
                      </td>
                      <td className="tbl__mono">
                        {d.reversible === true ? (
                          <span style={{ color: 'var(--accent)' }}>yes</span>
                        ) : d.reversible === false ? (
                          <span style={{ color: 'var(--warn)' }}>no</span>
                        ) : (
                          <span style={{ color: 'var(--ink-mute)' }}>—</span>
                        )}
                      </td>
                      <td className="tbl__mono" style={{ textAlign: 'right' }}>
                        <div>{fmtClockSec(d.createdAt)}</div>
                        <div style={{ color: 'var(--ink-mute)', fontSize: 10 }}>{fmtRelative(d.createdAt)}</div>
                        {d.runId !== null ? (
                          <Link
                            href={`/runs/${encodeURIComponent(d.runId)}`}
                            style={{ color: 'var(--ink-dim)', fontSize: 10, textDecoration: 'underline' }}
                          >
                            run · {d.runId.slice(0, 8)}
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '100', 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, 1000);
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};

const filterLabel: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
};
