import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveProjectFromParams } from '@/lib/project-context';
import { scanFeatureImportCandidates } from '@/lib/queries/feature-import-candidates';

import { ImportWizard } from './ImportWizard';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function ImportFeaturesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const projectCwd = project.cwd ?? process.cwd();
  const result = scanFeatureImportCandidates(projectCwd);

  return (
    <>
      <Topbar
        crumb={`${project.slug} / features / import`}
        crumbPrefix="coodra / projects"
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()} · IMPORT FEATURES</div>
            <h1 className="head__title">
              Promote existing <em>docs</em>.
            </h1>
            <p className="head__lede">
              We scanned <code style={mono}>docs/</code>, <code style={mono}>specs/</code>,{' '}
              <code style={mono}>architecture/</code>, <code style={mono}>arch/</code>, and{' '}
              <code style={mono}>design/</code> for markdown files that look like good feature candidates. Pick the ones
              you want, refine the slug + description for each, and we&apos;ll create matching features under{' '}
              <code style={mono}>docs/features/</code>. Originals are kept on disk — promotion is additive.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{result.candidates.length} candidate{result.candidates.length === 1 ? '' : 's'}</strong>
              <br />
              {result.scannedDirs.length > 0 ? `${result.scannedDirs.length} dir${result.scannedDirs.length === 1 ? '' : 's'} scanned` : 'no doc dirs found'}
              <br />
              {result.truncated ? <span style={{ color: 'var(--warn)' }}>capped at 50 — refine paths</span> : 'all visible'}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                ← back to features
              </Link>
              <Link className="btn" href={`/projects/${encodeURIComponent(project.slug)}/features/new`}>
                Create blank
              </Link>
            </div>
          </div>
        </div>

        {sp.error !== undefined ? (
          <div
            style={{
              padding: '12px 16px',
              marginBottom: 24,
              border: '1px solid var(--warn)',
              background: 'var(--warn-glow)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--warn)',
            }}
          >
            {sp.errorMessage ?? sp.error}
          </div>
        ) : null}

        {result.candidates.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, marginBottom: 12 }}>
              No <em>candidates</em> found.
            </h2>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)', marginBottom: 24 }}>
              We didn&apos;t find any markdown files between 200 B and 256 KB under the standard doc directories. Drop
              your spec files anywhere under <code style={mono}>docs/</code> / <code style={mono}>specs/</code> /{' '}
              <code style={mono}>architecture/</code>, or use the blank create form to author one from scratch.
            </p>
            <Link
              className="btn btn--accent"
              href={`/projects/${encodeURIComponent(project.slug)}/features/new`}
            >
              + Create from scratch
            </Link>
          </div>
        ) : (
          <ImportWizard
            projectSlug={project.slug}
            candidates={result.candidates.map((c) => ({
              relPath: c.relPath,
              absPath: c.absPath,
              bytes: c.bytes,
              modifiedAt: c.modifiedAt,
              suggestedSlug: c.suggestedSlug,
              slugCollides: c.slugCollides,
              suggestedDescription: c.suggestedDescription,
            }))}
            existingSlugs={[...result.existingSlugs]}
          />
        )}
      </section>
    </>
  );
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
