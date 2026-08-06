import Link from 'next/link';

import { ActorBadge } from '@/components/ActorBadge';
import { Topbar } from '@/components/Topbar';
import { actorDisplayNameProp } from '@/lib/actor-display';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { listAuditEvents } from '@/lib/queries/audit-events';
import { resolveClerkDisplayNames } from '@/lib/queries/clerk-users';
import { listProjects } from '@/lib/queries/projects';
import { readTeamConfig } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly project?: string;
  readonly limit?: string;
}

/**
 * `/audit` — the append-only `audit_events` ledger, workspace-wide.
 *
 * `audit_events` is a hash-chained record of policy/kill-switch
 * changes and privileged tool-call outcomes (`insertAuditEvent()` in
 * `packages/db/src/audit-events.ts`) — distinct from `/runs`,
 * `/decisions`, and `/context-packs` (the "Action Center" group),
 * which surface current-truth state rows, not the tamper-evident
 * who-did-what-to-what trail. The table existed and was being written
 * to since the audit design landed, but had no web route at all until
 * this page (2026-08-06).
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const projects = await listProjects();
  const projectMap = new Map(projects.map((p) => [p.slug, p]));
  const selectedProject = sp.project !== undefined && sp.project !== '' ? projectMap.get(sp.project) : undefined;
  const limit = clampLimit(sp.limit);
  const events = await listAuditEvents({
    ...(selectedProject !== undefined ? { projectId: selectedProject.id } : {}),
    limit,
  });

  const teamCfg = readTeamConfig();
  const viewerUserId = teamCfg.mode === 'team' ? (teamCfg.team?.clerkUserId ?? null) : null;
  const showAuthorColumn = teamCfg.mode === 'team' || events.some((e) => e.actorUserId !== null);
  const userDisplayNames =
    showAuthorColumn && teamCfg.mode === 'team'
      ? await resolveClerkDisplayNames(events.map((e) => e.actorUserId))
      : new Map<string, { label: string; email: string | null }>();

  return (
    <>
      <Topbar
        crumb="Audit"
        crumbPrefix={selectedProject !== undefined ? `coodra / ${selectedProject.slug}` : 'coodra'}
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /03 · GOVERN · AUDIT
              {selectedProject !== undefined ? ` · ${selectedProject.slug.toUpperCase()}` : ''}
            </div>
            <h1 className="head__title">
              Every <em>change</em>, chained.
            </h1>
            <p className="head__lede">
              An append-only, hash-chained record of policy changes, kill-switch activity, and privileged tool-call
              outcomes — <code style={mono}>audit_events</code>, distinct from the current-truth state in Runs,
              Decisions, and Context packs. Each row&apos;s hash covers the previous row&apos;s hash, so a deleted or
              edited entry breaks the chain.
              {selectedProject !== undefined ? (
                <>
                  {' Scoped to '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{selectedProject.slug}</span>
                  {' — '}
                  <Link href="/audit" style={{ textDecoration: 'underline', color: 'var(--ink-dim)' }}>
                    show all
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{events.length} events</strong>
              <br />
              {events.length === limit ? `more than ${limit}` : 'showing all'}
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

        {events.length === 0 ? (
          <div className="empty">
            <strong>
              No audit events <em>yet</em>.
            </strong>
            Policy publishes, kill-switch pause/resume, and privileged tool-call outcomes are recorded here as they
            happen.
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 18 }}></th>
                  <th>Event</th>
                  <th>Subject</th>
                  <th>Project</th>
                  {showAuthorColumn ? <th>Actor</th> : null}
                  <th>Result</th>
                  <th style={{ textAlign: 'right' }}>When</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => {
                  const resultColor =
                    e.result === 'success' ? 'var(--accent)' : e.result === 'denied' ? 'var(--warn)' : 'var(--caution)';
                  return (
                    <tr key={e.id}>
                      <td>
                        <span className="row__dot" style={{ background: resultColor }} />
                      </td>
                      <td style={{ maxWidth: 420 }}>
                        <div className="tbl__title">{e.eventType}</div>
                        <div
                          style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 11,
                            color: 'var(--ink-dim)',
                            marginTop: 4,
                          }}
                        >
                          {e.action}
                        </div>
                        {e.reason !== null && e.reason.length > 0 ? (
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
                            {e.reason}
                          </div>
                        ) : null}
                      </td>
                      <td className="tbl__mono" style={{ fontSize: 11 }}>
                        {e.subjectTable}
                        <div style={{ color: 'var(--ink-mute)', fontSize: 10 }}>{e.subjectId.slice(0, 12)}</div>
                      </td>
                      <td className="tbl__mono">
                        {e.projectSlug !== null ? (
                          <Link
                            href={`/projects/${encodeURIComponent(e.projectSlug)}`}
                            style={{ color: 'var(--ink-dim)' }}
                          >
                            {e.projectSlug}
                          </Link>
                        ) : (
                          <span style={{ color: 'var(--ink-mute)' }}>—</span>
                        )}
                      </td>
                      {showAuthorColumn ? (
                        <td>
                          <ActorBadge
                            userId={e.actorUserId}
                            viewerUserId={viewerUserId}
                            {...actorDisplayNameProp(e.actorUserId, userDisplayNames)}
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
                            color: resultColor,
                          }}
                        >
                          {e.result}
                        </span>
                      </td>
                      <td className="tbl__mono" style={{ textAlign: 'right' }}>
                        <div>{fmtClockSec(e.createdAt)}</div>
                        <div style={{ color: 'var(--ink-mute)', fontSize: 10 }}>{fmtRelative(e.createdAt)}</div>
                        {e.runId !== null ? (
                          <Link
                            href={`/runs/${encodeURIComponent(e.runId)}`}
                            style={{ color: 'var(--ink-dim)', fontSize: 10, textDecoration: 'underline' }}
                          >
                            run · {e.runId.slice(0, 8)}
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
