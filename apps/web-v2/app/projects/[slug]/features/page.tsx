import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { reindexFeaturesAction } from '@/lib/actions/features';
import { fmtRelative } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchProjectFeaturesSnapshot } from '@/lib/queries/features';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly created?: string;
  readonly removed?: string;
  readonly reindexed?: string;
  readonly imported?: string;
  readonly failed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

/**
 * `/projects/[slug]/features` — read-only list of every skill-style
 * feature for the project. Mirrors the layout of `/packs` but scoped to
 * one project and pointed at `<projectCwd>/docs/features/`.
 *
 * Phase E (read-only): renders the index. Phase F adds the create /
 * edit / remove / reindex server actions and the +Add CTA.
 */
export default async function ProjectFeaturesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const projectCwd = project.cwd ?? process.cwd();
  const cwdRecorded = project.cwd !== null;
  const snap = fetchProjectFeaturesSnapshot({ projectSlug: project.slug, projectCwd });

  const stableCount = snap.features.filter((f) => f.maturity === 'stable').length;
  const draftCount = snap.features.filter((f) => f.maturity === 'draft').length;
  const warningCount = snap.slugsWithWarnings.length;

  return (
    <>
      <Topbar crumb={`${project.slug} / features`} crumbPrefix="coodra / projects" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()} · FEATURES</div>
            <h1 className="head__title">
              Features as <em>skills</em>.
            </h1>
            <p className="head__lede">
              Each feature is a self-contained knowledge unit — a description that tells the agent <em>when to use it</em>,
              plus a body and any supporting files. The agent reads the index on every SessionStart, then loads a feature
              body on demand via <code style={mono}>coodra__get_feature</code>.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {snap.features.length} feature{snap.features.length === 1 ? '' : 's'}
              </strong>
              <br />
              {stableCount} stable · {draftCount} draft
              <br />
              {snap.featuresRoot}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}`}>
                ← back to {project.slug}
              </Link>
              <form action={reindexFeaturesAction} style={{ display: 'inline' }}>
                <input type="hidden" name="projectSlug" value={project.slug} />
                <button className="btn btn--ghost" type="submit" title="Force-regenerate INDEX.md + INDEX.json">
                  Re-index
                </button>
              </form>
              <Link
                className="btn btn--ghost"
                href={`/projects/${encodeURIComponent(project.slug)}/features/import`}
                title="Scan docs/, specs/, architecture/ for existing markdown files to promote to features"
              >
                Import existing docs
              </Link>
              <Link className="btn btn--accent" href={`/projects/${encodeURIComponent(project.slug)}/features/new`}>
                + Add feature
              </Link>
            </div>
          </div>
        </div>

        {sp.created !== undefined ? (
          <Banner tone="ok">
            Feature <code style={mono}>{sp.created}</code> created. Bridge picks it up on next SessionStart.
          </Banner>
        ) : null}
        {sp.removed !== undefined ? (
          <Banner tone="ok">
            Feature <code style={mono}>{sp.removed}</code> removed and INDEX regenerated.
          </Banner>
        ) : null}
        {sp.reindexed !== undefined ? (
          <Banner tone="ok">
            INDEX regenerated.{' '}
            {sp.reindexed === 'unchanged' ? 'No content changed.' : 'Disk content was newer than the index — refreshed.'}
          </Banner>
        ) : null}
        {sp.imported !== undefined && sp.imported.length > 0 ? (
          <Banner tone="ok">
            Imported {sp.imported.split(',').length} feature{sp.imported.split(',').length === 1 ? '' : 's'}:{' '}
            <code style={mono}>{sp.imported.replace(/,/g, ', ')}</code>. Original markdown files preserved on disk.
          </Banner>
        ) : null}
        {sp.failed !== undefined && sp.failed.length > 0 ? (
          <Banner tone="warn">
            {sp.failed.split(',').length} feature{sp.failed.split(',').length === 1 ? '' : 's'} failed to import (
            <code style={mono}>{sp.failed.replace(/,/g, ', ')}</code>). {sp.errorMessage ?? ''}
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {!cwdRecorded ? (
          <Banner tone="warn">
            This project has no recorded <code style={mono}>cwd</code> — reads / writes are pointed at the web server&apos;s
            working directory (<code style={mono}>{projectCwd}</code>), which may not be the project&apos;s real folder.
            Open Claude Code inside the project root once or re-run <code style={mono}>coodra init</code>.
          </Banner>
        ) : null}

        {warningCount > 0 ? (
          <Banner tone="warn">
            {warningCount} feature{warningCount === 1 ? ' has' : 's have'} validation warnings — open the affected
            feature{warningCount === 1 ? '' : 's'} below to see the lint output. Common causes: short or generic
            description, missing imperative trigger, no concrete signal.
          </Banner>
        ) : null}

        {!snap.rootExists ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 28, marginBottom: 12 }}>
              No <em>features</em> yet.
            </h2>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)', marginBottom: 24 }}>
              Define a feature for each meaningful concern in your project — auth, billing, the import pipeline,
              whatever. Drop in any markdown / code samples / specs that help an agent understand it. We index the
              triggers; the agent picks what to load.
            </p>
            <Link
              className="btn btn--accent"
              href={`/projects/${encodeURIComponent(project.slug)}/features/new`}
              style={{ fontSize: 14, padding: '14px 22px' }}
            >
              + Define your first feature
            </Link>
          </div>
        ) : snap.features.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, marginBottom: 12 }}>
              <code style={mono}>docs/features/</code> exists but is empty.
            </h2>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)', marginBottom: 24 }}>
              Run <code style={mono}>coodra feature add &lt;slug&gt;</code> from the project root, or click below to
              add one via the web wizard.
            </p>
            <Link
              className="btn btn--accent"
              href={`/projects/${encodeURIComponent(project.slug)}/features/new`}
            >
              + Add feature
            </Link>
          </div>
        ) : (
          <div className="dash-list" style={{ marginTop: 4 }}>
            {snap.features.map((f) => (
              <Link
                key={f.slug}
                href={`/projects/${encodeURIComponent(project.slug)}/features/${encodeURIComponent(f.slug)}`}
                className="row"
                style={{ display: 'grid', textDecoration: 'none' }}
              >
                <div className={`row__dot ${f.maturity === 'deprecated' ? 'row__dot--warn' : ''}`}></div>
                <div className="row__main">
                  <div className="row__title">
                    <em>{f.slug}</em>
                    {f.maturity !== 'stable' ? (
                      <span style={{ marginLeft: 8, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                        · {f.maturity}
                      </span>
                    ) : null}
                  </div>
                  <div className="row__sub" style={{ maxWidth: 720 }}>
                    {truncate(f.description, 200)}
                  </div>
                </div>
                <div className="row__verdict">
                  {f.hasWarnings ? (
                    <span className="badge badge--caution">
                      <span className="badge__dot"></span>
                      WARN
                    </span>
                  ) : (
                    <span className="badge badge--ok">
                      <span className="badge__dot"></span>
                      OK
                    </span>
                  )}
                </div>
                <div className="row__time">
                  {f.fileCount} file{f.fileCount === 1 ? '' : 's'} · {fmtRelative(f.lastUpdatedAt)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  if (oneline.length <= max) return oneline;
  return `${oneline.slice(0, max - 1)}…`;
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
