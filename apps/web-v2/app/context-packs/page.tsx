import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { listAllPacks } from '@/lib/queries/all-context-packs';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly project?: string;
  readonly source?: string;
  readonly limit?: string;
}

const SOURCE_FILTERS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'All' },
  { value: 'agent', label: 'Agent' },
  { value: 'bridge_auto', label: 'Bridge auto' },
];

/**
 * `/context-packs` — workspace-wide Context Pack browser.
 *
 * Pre-cleanup, packs were only visible per-run on `/runs/[id]`. The
 * agent's `list_context_packs` MCP tool covered this gap for the
 * agent but operators had to grep DB. This page surfaces the same
 * data with a `source` filter — agent-authored narratives vs. bridge
 * auto-summaries.
 */
export default async function ContextPacksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const projects = await listProjects();
  const projectMap = new Map(projects.map((p) => [p.slug, p]));
  const selectedProject = sp.project !== undefined && sp.project !== '' ? projectMap.get(sp.project) : undefined;
  const sourceFilter = sp.source ?? '';
  const limit = clampLimit(sp.limit);

  const packs = await listAllPacks({
    ...(selectedProject !== undefined ? { projectId: selectedProject.id } : {}),
    ...(sourceFilter === 'agent' || sourceFilter === 'bridge_auto' ? { source: sourceFilter } : {}),
    limit,
  });

  const agentCount = packs.filter((p) => p.source === 'agent').length;
  const autoCount = packs.length - agentCount;

  return (
    <>
      <Topbar
        crumb="Context Packs"
        crumbPrefix={selectedProject !== undefined ? `contextos / ${selectedProject.slug}` : 'contextos'}
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /04 · KNOWLEDGE · CONTEXT PACKS
              {selectedProject !== undefined ? ` · ${selectedProject.slug.toUpperCase()}` : ''}
            </div>
            <h1 className="head__title">
              Every <em>session</em>, recapped.
            </h1>
            <p className="head__lede">
              A Context Pack is the durable summary of one agent session — what was built, what was decided, what&apos;s
              still open. <strong style={{ color: 'var(--accent)' }}>Agent</strong> packs are explicit narratives the
              agent wrote via <code style={mono}>save_context_pack</code>;{' '}
              <strong style={{ color: 'var(--ink-dim)' }}>bridge auto</strong> packs are structured event digests the
              bridge wrote when the agent didn&apos;t.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{packs.length} packs</strong>
              <br />
              {agentCount} agent · {autoCount} auto
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={filterLabel}>Source</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {SOURCE_FILTERS.map((opt) => (
                <label
                  key={opt.value || '_all'}
                  style={{
                    cursor: 'pointer',
                    padding: '6px 10px',
                    border: `1px solid ${sourceFilter === opt.value ? 'var(--accent)' : 'var(--rule-strong)'}`,
                    color: sourceFilter === opt.value ? 'var(--accent)' : 'var(--ink-dim)',
                    fontFamily: 'var(--mono)',
                    fontSize: 9,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                  }}
                >
                  <input
                    type="radio"
                    name="source"
                    value={opt.value}
                    defaultChecked={sourceFilter === opt.value}
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

        {packs.length === 0 ? (
          <div className="empty">
            <strong>
              No Context Packs <em>yet</em>.
            </strong>
            They appear here as agent sessions complete (or as the bridge auto-saves on missed-stop scenarios).
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 18 }}></th>
                  <th>Title</th>
                  <th>Excerpt</th>
                  <th>Project</th>
                  <th>Source</th>
                  <th style={{ textAlign: 'right' }}>Saved</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span
                        className="row__dot"
                        style={{
                          background: p.source === 'agent' ? 'var(--accent)' : 'var(--ink-mute)',
                        }}
                      />
                    </td>
                    <td>
                      <Link
                        href={`/runs/${encodeURIComponent(p.runId)}`}
                        style={{ color: 'var(--ink)', textDecoration: 'none' }}
                      >
                        <div className="tbl__title">{p.title}</div>
                        <div className="tbl__mono" style={{ fontSize: 10 }}>
                          {p.id.slice(0, 12)}
                        </div>
                      </Link>
                    </td>
                    <td style={{ maxWidth: 400, fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.5 }}>
                      {p.contentExcerpt.slice(0, 220)}
                      {p.contentExcerpt.length > 220 ? '…' : ''}
                    </td>
                    <td className="tbl__mono">
                      {p.projectSlug !== null ? (
                        <Link
                          href={`/projects/${encodeURIComponent(p.projectSlug)}`}
                          style={{ color: 'var(--ink-dim)' }}
                        >
                          {p.projectSlug}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--ink-mute)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge ${p.source === 'agent' ? 'badge--ok' : ''}`}
                        title={
                          p.source === 'agent'
                            ? 'Agent-authored narrative via save_context_pack'
                            : 'Bridge auto-summary fallback (agent did not call save_context_pack)'
                        }
                      >
                        <span className="badge__dot"></span>
                        {p.source === 'agent' ? 'AGENT' : 'AUTO'}
                      </span>
                    </td>
                    <td className="tbl__mono" style={{ textAlign: 'right' }}>
                      <div>{fmtClockSec(p.createdAt)}</div>
                      <div style={{ color: 'var(--ink-mute)', fontSize: 10 }}>{fmtRelative(p.createdAt)}</div>
                    </td>
                  </tr>
                ))}
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
