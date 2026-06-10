import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listWikisByProject } from '@/lib/queries/wiki';

export const dynamic = 'force-dynamic';

/**
 * `/wiki` — Module 10 Deep Wiki index. Lists every generated wiki across
 * the workspace, grouped by project. Each card links to the hierarchical
 * reader at `/wiki/<id>`.
 *
 * Wikis are authored by the user's coding agent (Claude Code / Codex /
 * Cursor) via Coodra's wiki_* MCP tools — Coodra runs no LLM. Operators
 * kick one off with `coodra wiki generate`.
 */
export default async function WikiIndexPage() {
  const groups = await listWikisByProject();
  const total = groups.reduce((n, g) => n + g.wikis.length, 0);

  return (
    <>
      <Topbar crumb="Deep Wiki" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/10 · KNOWLEDGE · DEEP WIKI</div>
            <h1 className="head__title">
              A hierarchical map of the codebase, <em>authored by your agent</em>.
            </h1>
            <p className="head__lede">
              Deep Wikis are DeepWiki-style, mind-map explanations of a codebase — sections, pages, diagrams. Your
              coding agent is the model; Coodra ships the grounding, the persistence, and this render. Kick one off with{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra wiki generate</span> then ask
              the agent to build it.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {total} wiki{total === 1 ? '' : 's'}
              </strong>
              <br />
              {groups.length} project{groups.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        {total === 0 ? (
          <div className="empty">
            <strong>
              No wikis <em>yet</em>.
            </strong>
            Run <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra wiki generate</span> from a
            project root, then tell your agent &ldquo;generate the deep wiki&rdquo;. Pages land here as the agent
            authors them.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.projectSlug} style={{ marginBottom: 28 }}>
              <h2
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--ink-mute)',
                  margin: '0 0 12px',
                }}
              >
                {group.projectName}
              </h2>
              <div className="pack-grid">
                {group.wikis.map((w) => {
                  const done = w.pageCount > 0 && w.authoredCount === w.pageCount;
                  return (
                    <Link key={w.id} href={`/wiki/${w.id}`} className="pack" style={{ textDecoration: 'none' }}>
                      <div
                        className="pack__num"
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                      >
                        <span>/ {w.slug.toUpperCase()}</span>
                        <span className={`badge ${done ? 'badge--ok' : 'badge--caution'}`}>
                          <span className="badge__dot"></span>
                          {done ? 'COMPLETE' : 'IN PROGRESS'}
                        </span>
                      </div>
                      <h3 className="pack__title">{w.title}</h3>
                      <p className="pack__excerpt">
                        {w.authoredCount} / {w.pageCount} pages authored · {w.mode}
                      </p>
                      <div className="pack__meta">
                        <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>
                          {formatRelative(w.updatedAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
