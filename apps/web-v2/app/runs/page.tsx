import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { cancelRunAction } from '@/lib/actions/runs';
import { agentTypeLabel } from '@/lib/agent-label';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { listProjectsForFilter, listRuns } from '@/lib/queries/runs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly project?: string;
  readonly status?: string;
  readonly limit?: string;
  readonly cancelled?: string;
  readonly noop?: string;
  readonly error?: string;
  /** Toggle to include 'abandoned' runs + synthetic backfill rows in the list. */
  readonly showNoise?: string;
}

const STATUS_FILTERS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'All' },
  { value: 'in_progress', label: 'Running' },
  { value: 'completed', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
  { value: 'abandoned', label: 'Abandoned' },
];

/**
 * Default-hidden statuses on `/runs`. `abandoned` runs are typically
 * dev-test artifacts where SessionEnd never fired (process crash, exit
 * without /exit, direct-MCP smoke tests). They have audit value but
 * pollute the operator's day-to-day view. Toggle the `showNoise=1`
 * query param to include them.
 */
const DEFAULT_HIDDEN_STATUSES: ReadonlyArray<string> = ['abandoned'];

/**
 * Synthetic session-id patterns to hide by default. Cleanup writes
 * orphan-event backfill rows under sessions like
 * `orphan-backfill-2-<ts>`; the doctor's `__coodra_synthetic__`
 * probe rows are now hard-deleted but the pattern guard remains as
 * defense-in-depth.
 */
const SYNTHETIC_SESSION_PATTERN = 'orphan-backfill';

export default async function RunsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const limit = clampLimit(sp.limit);
  const projects = await listProjectsForFilter();
  const projectMap = new Map(projects.map((p) => [p.slug, p]));
  const selectedProject = sp.project !== undefined && sp.project !== '' ? projectMap.get(sp.project) : undefined;
  const statusFilter = sp.status ?? '';
  // showNoise param overrides the default-hide. When `status` filter is
  // explicitly set to 'abandoned', show those rows even without the toggle.
  const showNoise = sp.showNoise !== undefined && sp.showNoise !== '0' && sp.showNoise !== '';
  const includeAbandoned = showNoise || statusFilter === 'abandoned';

  const filter = {
    ...(selectedProject !== undefined ? { projectId: selectedProject.id } : {}),
    ...(statusFilter !== '' ? { status: statusFilter } : {}),
    ...(!includeAbandoned ? { excludeStatuses: DEFAULT_HIDDEN_STATUSES } : {}),
    ...(showNoise ? {} : { excludeSessionIdPattern: SYNTHETIC_SESSION_PATTERN }),
    limit,
  };
  const { runs, hasMore } = await listRuns(filter);
  const projectIdMap = new Map(projects.map((p) => [p.id, p]));

  return (
    <>
      <Topbar crumb="Runs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · AUDIT</div>
            <h1 className="head__title">
              Every <em>run</em>, every event.
            </h1>
            <p className="head__lede">
              A run is one Claude / Cursor / Windsurf session against a project. Every tool call is a row; every row
              carries a verdict. Nothing is reconstructed — it&apos;s recorded.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{runs.length} runs</strong>
              <br />
              {hasMore ? `more than ${limit}` : 'showing all'}
              <br />
              {projects.length} projects
            </div>
            <div className="head__actions">
              {showNoise ? (
                <Link className="btn btn--ghost" href="/runs" title="Hide abandoned + synthetic backfill rows again">
                  Hide noise
                </Link>
              ) : (
                <Link
                  className="btn btn--ghost"
                  href="/runs?showNoise=1"
                  title="Include abandoned + synthetic backfill rows (audit-only)"
                >
                  Show all
                </Link>
              )}
              <Link className="btn btn--ghost" href="/runs">
                Reset filter
              </Link>
            </div>
          </div>
        </div>

        {sp.cancelled !== undefined ? (
          <div className="banner banner--ok">Run cancelled · {sp.cancelled.slice(0, 8)}</div>
        ) : null}
        {sp.noop !== undefined ? <div className="banner">Already terminal · {sp.noop.slice(0, 8)} (no-op)</div> : null}
        {sp.error !== undefined ? <div className="banner banner--warn">Error: {sp.error}</div> : null}

        {/* Filter bar — project dropdown + status pills */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={filterLabel}>Status</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {STATUS_FILTERS.map((opt) => (
                <label
                  key={opt.value || '_all'}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 10px',
                    border: `1px solid ${statusFilter === opt.value ? 'var(--accent)' : 'var(--rule-strong)'}`,
                    color: statusFilter === opt.value ? 'var(--accent)' : 'var(--ink-dim)',
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                  }}
                >
                  <input
                    type="radio"
                    name="status"
                    value={opt.value}
                    defaultChecked={statusFilter === opt.value}
                    style={{ display: 'none' }}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn--sm" type="submit" style={{ marginLeft: 'auto' }}>
            Apply
          </button>
        </form>

        <div className="card" style={{ padding: 0 }}>
          {runs.length === 0 ? (
            <div className="empty" style={{ border: 'none' }}>
              <strong>
                No runs <em>recorded</em>.
              </strong>
              {selectedProject !== undefined || statusFilter !== ''
                ? 'Loosen the filter or clear it.'
                : 'The first agent session against any project will appear here.'}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 18 }}></th>
                  <th>Run</th>
                  <th>Session</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Project</th>
                  <th style={{ textAlign: 'right' }}>Started</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const project = projectIdMap.get(run.projectId);
                  const dotCls =
                    run.status === 'in_progress' ? 'row__dot--w' : run.status === 'cancelled' ? 'row__dot--warn' : '';
                  const badgeCls =
                    run.status === 'completed'
                      ? 'badge--ok'
                      : run.status === 'cancelled'
                        ? 'badge--warn'
                        : 'badge--caution';
                  return (
                    <tr key={run.id}>
                      <td>
                        <span className={`row__dot ${dotCls}`}></span>
                      </td>
                      <td>
                        <div className="tbl__title">
                          run · <em>{run.id.slice(0, 8)}</em>
                        </div>
                        <div className="tbl__mono">{run.id}</div>
                      </td>
                      <td className="tbl__mono">{run.sessionId.slice(0, 14)}</td>
                      <td className="tbl__mono">{agentTypeLabel(run.agentType)}</td>
                      <td>
                        <span className={`badge ${badgeCls}`}>
                          <span className="badge__dot"></span>
                          {run.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="tbl__mono">
                        {project !== undefined ? (
                          <Link
                            href={`/projects/${encodeURIComponent(project.slug)}`}
                            style={{ color: 'var(--ink-dim)' }}
                          >
                            {project.slug}
                          </Link>
                        ) : (
                          run.projectId.slice(0, 8)
                        )}
                      </td>
                      <td className="tbl__mono" style={{ textAlign: 'right' }}>
                        {fmtClockSec(run.startedAt)}
                        <div style={{ color: 'var(--ink-mute)', fontSize: 10 }}>{fmtRelative(run.startedAt)}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {run.status === 'in_progress' ? (
                          <div style={{ display: 'inline-flex', gap: 6 }}>
                            <Link className="btn btn--sm btn--accent" href={`/runs/${run.id}/live`}>
                              Live →
                            </Link>
                            <form action={cancelRunAction} style={{ display: 'inline' }}>
                              <input type="hidden" name="id" value={run.id} />
                              <input type="hidden" name="returnTo" value="/runs" />
                              <button
                                className="btn btn--sm btn--ghost"
                                type="submit"
                                title="Force-complete this run (sets status=cancelled, ended_at=now)"
                              >
                                Cancel
                              </button>
                            </form>
                          </div>
                        ) : (
                          <Link className="btn btn--sm btn--ghost" href={`/runs/${run.id}`}>
                            Open
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {hasMore ? (
          <div style={{ marginTop: 24, textAlign: 'center' }}>
            <Link
              className="btn btn--sm"
              href={`/runs?${new URLSearchParams({
                ...(selectedProject !== undefined ? { project: selectedProject.slug } : {}),
                ...(statusFilter !== '' ? { status: statusFilter } : {}),
                limit: String(limit * 2),
              }).toString()}`}
            >
              Show more
            </Link>
          </div>
        ) : null}
      </section>
    </>
  );
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}

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
