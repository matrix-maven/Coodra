import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { fmtRelative } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchFeatureDetail } from '@/lib/queries/features';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly saved?: string;
  readonly uploaded?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

/**
 * `/projects/[slug]/features/[fslug]` — read-only detail view of one
 * feature. Shows frontmatter, body, supporting-file tree, validation
 * warnings. Phase F adds the edit / upload / remove actions.
 *
 * Body is rendered as monospace pre-formatted text in v1 (simpler than
 * pulling in a markdown renderer; matches the read-only nature of the
 * page). Phase F's edit page uses a textarea with the same shape.
 */
export default async function FeatureDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; fslug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const { fslug } = await params;
  const sp = await searchParams;
  const projectCwd = project.cwd ?? process.cwd();
  const row = fetchFeatureDetail({ projectCwd, slug: decodeURIComponent(fslug) });
  if (row === null) notFound();

  const fm = row.frontmatter;
  const featureUrl = `/projects/${encodeURIComponent(project.slug)}/features/${encodeURIComponent(row.slug)}`;

  return (
    <>
      <Topbar
        crumb={`${project.slug} / features / ${row.slug}`}
        crumbPrefix="coodra / projects"
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()} · FEATURE · {row.slug.toUpperCase()}</div>
            <h1 className="head__title">
              <em>{row.slug}</em>
              {fm.maturity && fm.maturity !== 'stable' ? (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink-mute)', marginLeft: 16 }}>
                  · {fm.maturity}
                </span>
              ) : null}
            </h1>
            <p className="head__lede">{fm.description}</p>
            {fm.whenNotToUse ? (
              <p className="head__lede" style={{ color: 'var(--ink-dim)' }}>
                <strong>Not for:</strong> {fm.whenNotToUse}
              </p>
            ) : null}
          </div>
          <div>
            <div className="head__meta">
              <strong>{row.files.length + 1} file{row.files.length === 0 ? '' : 's'}</strong>
              <br />
              {formatBytes(row.totalBytes)} · last updated {fmtRelative(row.lastUpdatedAt)}
              <br />
              maturity: {fm.maturity ?? 'draft'}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                ← back to features
              </Link>
              <Link className="btn" href={`${featureUrl}/edit`}>
                Edit
              </Link>
            </div>
          </div>
        </div>

        {sp.saved !== undefined ? <Banner tone="ok">Feature saved.</Banner> : null}
        {sp.uploaded !== undefined ? (
          <Banner tone="ok">
            File <code style={mono}>{sp.uploaded}</code> uploaded.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {row.warnings.length > 0 ? (
          <Banner tone="warn">
            <strong>Validation warnings ({row.warnings.length}):</strong>
            <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
              {row.warnings.map((w, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {w}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <div className="dash-grid">
          <div>
            <div className="card__head" style={{ marginBottom: 16 }}>
              <h2 className="card__title">
                <em>feature.md</em> body
              </h2>
              <span className="card__role">loaded by `coodra__get_feature`</span>
            </div>
            <pre
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--rule)',
                padding: '20px 24px',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--ink)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowX: 'auto',
                maxHeight: 720,
                overflowY: 'auto',
              }}
            >
              {row.body || <span style={{ color: 'var(--ink-mute)' }}>(empty body)</span>}
            </pre>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Frontmatter
                </h3>
              </div>
              <dl style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.8, margin: 0 }}>
                <Field label="name" value={fm.name} />
                <Field label="maturity" value={fm.maturity ?? 'draft'} />
                {(fm.tags ?? []).length > 0 ? <Field label="tags" value={(fm.tags ?? []).join(', ')} /> : null}
                {(fm.owners ?? []).length > 0 ? <Field label="owners" value={(fm.owners ?? []).join(', ')} /> : null}
              </dl>
            </div>

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Supporting <em>files</em>
                </h3>
                <span className="card__role">{row.files.length}</span>
              </div>
              {row.files.length === 0 ? (
                <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)', margin: 0 }}>
                  No supporting files. Add any md / code / spec files to this feature&apos;s folder so the agent can
                  fetch them via <code style={mono}>get_feature_file</code>.
                </p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {row.files.map((f) => (
                    <li key={f.path} style={{ marginBottom: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>
                      <Link
                        href={`${featureUrl}/files/${f.path
                          .split('/')
                          .map((seg) => encodeURIComponent(seg))
                          .join('/')}`}
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      >
                        {f.path}
                      </Link>
                      <span style={{ color: 'var(--ink-dim)', marginLeft: 8 }}>{formatBytes(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  On <em>disk</em>
                </h3>
              </div>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-dim)', wordBreak: 'break-all', margin: 0 }}>
                {row.dir}
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <dt style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--ink-mute)' }}>
        {label}
      </dt>
      <dd style={{ margin: 0, color: 'var(--ink)' }}>{value}</dd>
    </div>
  );
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
