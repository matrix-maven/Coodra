import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listGraphifyProjects } from '@/lib/queries/graphify';
import { countProjectsHiddenByOrgScope } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

/**
 * `/graphify` — codebase-graph index (Module 09 track 9B, artifact half).
 *
 * Lists every registered project on this machine and whether Graphify has
 * produced a graph for it. Coodra generates nothing here: Graphify's own CLI
 * writes the artifacts (ADR-010/015), `coodra graphify build` just pins where
 * they land, and this page reads them back.
 *
 * Local-only. A team-hosted deployment has no developer checkout on disk, so
 * the page renders the CLI instructions instead of an empty table.
 */
export default async function GraphifyIndexPage() {
  const { cloudHosted, projects } = await listGraphifyProjects();
  const built = projects.filter((p) => p.hasGraph);
  const notBuilt = projects.filter((p) => !p.hasGraph);
  const orgScope = cloudHosted ? { hidden: 0, orgIds: [] as readonly string[] } : await countProjectsHiddenByOrgScope();

  return (
    <>
      <Topbar crumb="Codebase graph" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/09 · KNOWLEDGE · CODEBASE GRAPH</div>
            <h1 className="head__title">
              What your code <em>actually</em> looks like.
            </h1>
            <p className="head__lede">
              Graphify extracts a knowledge graph from your repository — files, symbols, the calls between them, and the
              Leiden communities they cluster into. Coodra doesn&rsquo;t build it and doesn&rsquo;t re-implement it: it
              pins where the output lands and reads it back here. Build one with <Mono>coodra graphify build</Mono>.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {built.length} graph{built.length === 1 ? '' : 's'}
              </strong>
              <br />
              {projects.length} project{projects.length === 1 ? '' : 's'}
            </div>
          </div>
        </div>

        {cloudHosted ? (
          <div className="banner banner--caution">
            <strong>Graphs are local.</strong> The artifacts live in each developer&rsquo;s checkout (
            <Mono>.coodra/graphify/out/</Mono>), not in the shared database — this deployment has no repository on disk
            to read. Run <Mono>coodra graphify build</Mono> then <Mono>coodra graphify open</Mono> on your own machine.
          </div>
        ) : projects.length === 0 ? (
          <div className="empty">
            <strong>
              No projects <em>registered</em>.
            </strong>
            Run <Mono>coodra init</Mono> from a project root first, then <Mono>coodra graphify build</Mono>.
          </div>
        ) : (
          <>
            {built.length > 0 ? (
              <div className="pack-grid">
                {built.map((p) => (
                  <ProjectCard key={p.slug} project={p} />
                ))}
              </div>
            ) : (
              <div className="empty">
                <strong>
                  No graphs <em>built yet</em>.
                </strong>
                Run <Mono>coodra graphify build</Mono> in any registered project below, then reload.
              </div>
            )}
            {/* QA sweep 2026-07-24: every registered-but-unbuilt project used
                to render a FULL card — 40+ near-identical "No graph yet"
                tiles drowned the single built graph. Collapse them. */}
            {notBuilt.length > 0 ? (
              <details style={{ marginTop: 24 }} open={built.length === 0}>
                <summary
                  style={{ cursor: 'pointer', color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 12 }}
                >
                  {notBuilt.length} project{notBuilt.length === 1 ? '' : 's'} without a graph — run{' '}
                  <Mono>coodra graphify build</Mono> in the repo to add one
                </summary>
                <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 4 }}>
                  {notBuilt.map((p) => (
                    <li key={p.slug} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {p.cwd === null ? (
                        <span style={{ color: 'var(--ink-mute)' }}>
                          {p.slug} — no recorded root (re-run <Mono>coodra init</Mono> there)
                        </span>
                      ) : (
                        <>
                          <Link href={`/graphify/${encodeURIComponent(p.slug)}`} style={{ color: 'var(--ink-dim)' }}>
                            {p.slug}
                          </Link>
                          <span style={{ color: 'var(--ink-mute)' }}> · {p.cwd}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
        {orgScope.hidden > 0 ? (
          <p style={{ marginTop: 20, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
            {orgScope.hidden} project{orgScope.hidden === 1 ? '' : 's'} in this machine&rsquo;s database belong
            {orgScope.hidden === 1 ? 's' : ''} to a different org/mode and {orgScope.hidden === 1 ? 'is' : 'are'} not
            shown — the web lists only the active org&rsquo;s projects. Check <Mono>coodra org status</Mono> or switch
            mode to see them.
          </p>
        ) : null}
      </section>
    </>
  );
}

function ProjectCard({
  project,
}: {
  readonly project: Awaited<ReturnType<typeof listGraphifyProjects>>['projects'][number];
}) {
  const body = (
    <>
      <div
        className="pack__num"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
      >
        <span>/ {project.slug.toUpperCase()}</span>
        <span className={`badge ${project.hasGraph ? 'badge--ok' : 'badge--caution'}`}>
          <span className="badge__dot"></span>
          {project.hasGraph ? 'BUILT' : project.cwd === null ? 'NO ROOT' : 'NOT BUILT'}
        </span>
      </div>
      <h3 className="pack__title">{project.name}</h3>
      <p className="pack__excerpt">
        {project.hasGraph ? (
          <>
            {project.nodes ?? '?'} nodes · {project.links ?? '?'} edges · {project.communities ?? '?'} communities
          </>
        ) : project.cwd === null ? (
          <>No recorded project root — re-run coodra init from the project directory.</>
        ) : (
          <>No graph yet. Run coodra graphify build in this project.</>
        )}
      </p>
      <div className="pack__meta">
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
          {project.cwd === null ? '—' : project.outputDir}
          {project.managedByCoodra ? ' · managed' : ''}
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>
          {project.builtAt === null ? '' : formatRelative(project.builtAt)}
        </span>
      </div>
    </>
  );

  // Only projects with a resolvable root get a detail page — a card with no
  // cwd has nothing to show there.
  if (project.cwd === null) {
    return (
      <div className="pack" style={{ opacity: 0.62 }}>
        {body}
      </div>
    );
  }
  return (
    <Link href={`/graphify/${encodeURIComponent(project.slug)}`} className="pack" style={{ textDecoration: 'none' }}>
      {body}
    </Link>
  );
}

function Mono({ children }: { readonly children: React.ReactNode }) {
  return <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{children}</span>;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
