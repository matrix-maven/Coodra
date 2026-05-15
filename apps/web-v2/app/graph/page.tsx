import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fmtRelative } from '@/lib/format';
import { loadGraph } from '@/lib/queries/graph';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

export default async function GraphPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const sp = await searchParams;
  const projects = await listProjects();
  const slug = sp.project ?? projects[0]?.slug ?? '';
  // The Graphify index lives under ~/.coodra/graphify/<slug>/graph.json
  // on each developer's laptop. In `team-hosted` mode there is no
  // ~/.coodra on the deployment server, so loadGraph would always
  // return a missing-index sentinel. Surface that as a deployment-aware
  // copy change rather than a confusing "no graph" with a misleading
  // local-only path in the lede.
  const dm = resolveDeploymentMode();
  const isTeamHosted = dm === 'team-hosted';
  const result = isTeamHosted || slug.length === 0 ? null : loadGraph(slug);

  return (
    <>
      <Topbar crumb="Context graph" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · AUDIT · GRAPH</div>
            <h1 className="head__title">
              Files the <em>agent</em> read.
            </h1>
            <p className="head__lede">
              {isTeamHosted ? (
                <>
                  A graph of files touched, the order they were touched, and the runs that touched them. The
                  Graphify index is per-laptop (each developer runs <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>graphify scan</code> against
                  their local checkout, producing <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>~/.coodra/graphify/&lt;slug&gt;/graph.json</code>),
                  so this view is empty on the hosted web. Open the same project's web app on your laptop
                  (local-team mode) to see your graph. Cross-team graph aggregation is a future enhancement.
                </>
              ) : (
                <>
                  A graph of files touched, the order they were touched, and the runs that touched them. Loaded
                  from{' '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                    ~/.coodra/graphify/&lt;slug&gt;/graph.json
                  </span>{' '}
                  per ADR-010.
                </>
              )}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{result?.status === 'ok' ? `${result.nodes.length} nodes` : 'no graph'}</strong>
              <br />
              {result?.status === 'ok' ? `${result.edgeCount} edges` : '—'}
              <br />
              project · {slug || 'none'}
            </div>
          </div>
        </div>

        {projects.length > 1 ? (
          <form
            method="get"
            style={{
              display: 'flex',
              gap: 12,
              marginBottom: 32,
              alignItems: 'center',
              padding: '16px 20px',
              border: '1px solid var(--rule)',
              background: 'var(--bg-2)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--ink-mute)',
              }}
            >
              Project
            </span>
            <select
              name="project"
              defaultValue={slug}
              style={{
                padding: '8px 10px',
                background: 'var(--bg)',
                border: '1px solid var(--rule-strong)',
                color: 'var(--ink)',
                fontFamily: 'var(--mono)',
                fontSize: 12,
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.slug}
                </option>
              ))}
            </select>
            <button className="btn btn--sm" type="submit">
              Load
            </button>
          </form>
        ) : null}

        {result === null || result.status === 'missing' ? (
          <div className="empty">
            <strong>
              No graph <em>for {slug || '—'}</em>.
            </strong>
            {result === null ? 'Pick a project above.' : (result as { howToFix: string }).howToFix}
          </div>
        ) : result.status === 'invalid' ? (
          <div className="empty">
            <strong>
              Graph <em>invalid</em>.
            </strong>
            {result.reason}
          </div>
        ) : (
          <>
            <div className="card" style={{ padding: 28, marginBottom: 24 }}>
              <div className="card__head">
                <h2 className="card__title">
                  Nodes <em>by community</em>
                </h2>
                <span className="card__role">
                  loaded {fmtRelative(result.mtime)} · {result.path}
                </span>
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', lineHeight: 1.7 }}>
                {result.nodes.length === 0 ? (
                  <span>No nodes in graph.</span>
                ) : (
                  result.nodes.slice(0, 60).map((n) => (
                    <div
                      key={n.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 1fr 80px 60px',
                        gap: 16,
                        padding: '8px 0',
                        borderBottom: '1px solid var(--rule)',
                      }}
                    >
                      <span style={{ color: 'var(--ink)' }}>{n.name}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {n.path}
                      </span>
                      <span>{n.kind}</span>
                      <span style={{ textAlign: 'right' }}>{n.community ?? '—'}</span>
                    </div>
                  ))
                )}
                {result.nodes.length > 60 ? (
                  <div style={{ marginTop: 12, color: 'var(--ink-mute)' }}>
                    + {result.nodes.length - 60} more nodes (truncated for the editorial view).
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
