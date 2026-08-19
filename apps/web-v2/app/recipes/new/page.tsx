import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

export default async function NewRecipeScopePage() {
  const projects = await listProjects();

  return (
    <>
      <Topbar crumb="Agent Recipes / new" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · KNOWLEDGE · NEW AGENT RECIPE</div>
            <h1 className="head__title">
              Pick where this recipe <em>belongs</em>.
            </h1>
            <p className="head__lede">
              Use a project scope when the recipe depends on a repository, file paths, architecture, or local supporting
              files. Use global scope for workspace-wide habits that apply across projects.
            </p>
          </div>
          <div className="head__actions">
            <Link className="btn btn--ghost" href="/recipes">
              ← back to scopes
            </Link>
          </div>
        </div>

        <div className="pack-grid">
          <Link className="pack" href="/recipes/global/new" style={{ textDecoration: 'none' }}>
            <div className="pack__num">/ GLOBAL</div>
            <h3 className="pack__title">
              <em>global</em> · workspace recipe
            </h3>
            <p className="pack__excerpt">
              Store this recipe in Coodra&apos;s global scope. It will not write into any project&apos;s
              <code style={mono}> .coodra/recipes/</code> folder.
            </p>
            <div className="pack__meta">
              <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>CREATE GLOBAL →</span>
            </div>
          </Link>

          {projects.map((project) => (
            <Link
              key={project.id}
              className="pack"
              href={`/projects/${encodeURIComponent(project.slug)}/recipes/new`}
              style={{ textDecoration: 'none' }}
            >
              <div className="pack__num">/ {project.slug.toUpperCase()}</div>
              <h3 className="pack__title">
                <em>{project.slug}</em>
              </h3>
              <p className="pack__excerpt">
                Store this recipe in {project.name}&apos;s own project folder, with optional supporting files available
                to the agent on demand.
              </p>
              <div className="pack__meta">
                <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>CREATE PROJECT RECIPE →</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
