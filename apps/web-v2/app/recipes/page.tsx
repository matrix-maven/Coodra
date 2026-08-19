import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { tryGetActor } from '@/lib/auth';
import { listFeaturesAcrossProjects } from '@/lib/queries/features-list';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

export default async function FeaturesPage() {
  const [features, projects, actor] = await Promise.all([listFeaturesAcrossProjects(), listProjects(), tryGetActor()]);
  const role = actor?.role ?? 'admin';
  const isViewer = role === 'viewer';
  const globalFeatures = features.filter((feature) => feature.projectSlug === '__global__');
  const projectStats = projects.map((project) => {
    const projectFeatures = features.filter((feature) => feature.projectSlug === project.slug);
    return {
      project,
      features: projectFeatures,
      published: projectFeatures.filter((feature) => feature.status === 'published').length,
      drafts: projectFeatures.filter((feature) => feature.status !== 'published').length,
      updatedAt: latestUpdatedAt(projectFeatures),
    };
  });
  const totalProjectRecipes = projectStats.reduce((sum, group) => sum + group.features.length, 0);

  return (
    <>
      <Topbar crumb="Agent Recipes" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · KNOWLEDGE · AGENT RECIPES</div>
            <h1 className="head__title">
              Choose the recipe <em>scope</em>.
            </h1>
            <p className="head__lede">
              Agent Recipes can be global guidance shared across the workspace, or project-specific guidance stored in
              that project&apos;s own recipe folder. Pick the scope first, then read, add, edit, or delete recipes
              inside that boundary.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {globalFeatures.length + totalProjectRecipes} Agent Recipe
                {globalFeatures.length + totalProjectRecipes === 1 ? '' : 's'}
              </strong>
              <br />
              {projects.length} project{projects.length === 1 ? '' : 's'} · {globalFeatures.length} global
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/templates">
                Templates
              </Link>
              {!isViewer ? (
                <Link className="btn btn--accent" href="/recipes/new">
                  + New recipe
                </Link>
              ) : (
                <span
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                    letterSpacing: '0.04em',
                    color: 'var(--ink-mute)',
                    padding: '6px 10px',
                    border: '1px dashed var(--ink-mute)',
                    borderRadius: 4,
                  }}
                  title="Viewers can browse every Agent Recipe but cannot author or edit."
                >
                  Read-only · viewer role
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="pack-grid">
          <Link className="pack" href="/recipes/global" style={{ textDecoration: 'none' }}>
            <div className="pack__num" style={cardMetaStyle}>
              <span>/ GLOBAL</span>
              <span className={`badge ${globalFeatures.length > 0 ? 'badge--ok' : 'badge--caution'}`}>
                <span className="badge__dot"></span>
                {globalFeatures.length > 0 ? 'READY' : 'EMPTY'}
              </span>
            </div>
            <h3 className="pack__title">
              <em>global</em> · workspace recipes
            </h3>
            <p className="pack__excerpt">
              Shared recipes for patterns that apply across projects. These live in the Coodra store instead of a
              project checkout.
            </p>
            <div className="pack__meta">
              <span style={{ color: 'var(--ink)' }}>
                {globalFeatures.length} recipe{globalFeatures.length === 1 ? '' : 's'}
              </span>
              <span style={{ color: 'var(--ink-mute)' }}>
                {globalFeatures.filter((feature) => feature.status === 'published').length} published
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>
                {formatRelative(latestUpdatedAt(globalFeatures))}
              </span>
            </div>
          </Link>

          {projectStats.map((group) => (
            <Link
              key={group.project.id}
              className="pack"
              href={`/projects/${encodeURIComponent(group.project.slug)}/recipes`}
              style={{ textDecoration: 'none' }}
            >
              <div className="pack__num" style={cardMetaStyle}>
                <span>/ {group.project.slug.toUpperCase()}</span>
                <span className={`badge ${group.features.length > 0 ? 'badge--ok' : 'badge--caution'}`}>
                  <span className="badge__dot"></span>
                  {group.features.length > 0 ? 'READY' : 'EMPTY'}
                </span>
              </div>
              <h3 className="pack__title">
                <em>{group.project.slug}</em>
              </h3>
              <p className="pack__excerpt">
                Project-specific recipes for {group.project.name}. New recipes in this scope are written to that
                project&apos;s own <code style={mono}>.coodra/recipes/</code> folder.
              </p>
              <div className="pack__meta">
                <span style={{ color: 'var(--ink)' }}>
                  {group.features.length} recipe{group.features.length === 1 ? '' : 's'}
                </span>
                <span style={{ color: 'var(--ink-mute)' }}>{group.published} published</span>
                {group.drafts > 0 ? <span style={{ color: 'var(--ink-mute)' }}>{group.drafts} draft</span> : null}
                <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>{formatRelative(group.updatedAt)}</span>
              </div>
            </Link>
          ))}
        </div>

        {projects.length === 0 ? (
          <div className="empty" style={{ marginTop: 24 }}>
            <strong>
              No projects <em>registered</em>.
            </strong>
            Register a project first, then project-specific recipes can be created inside that project&apos;s folder.
          </div>
        ) : null}
      </section>
    </>
  );
}

function latestUpdatedAt(features: ReadonlyArray<{ readonly updatedAt: Date }>): Date | null {
  return features.reduce<Date | null>(
    (latest, feature) => (latest === null || feature.updatedAt > latest ? feature.updatedAt : latest),
    null,
  );
}

function formatRelative(d: Date | null): string {
  if (d === null) return 'no updates';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const cardMetaStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
};

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
