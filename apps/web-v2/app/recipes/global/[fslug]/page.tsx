import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { getGlobalFeature } from '@/lib/queries/features-list';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly saved?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function GlobalFeatureDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ fslug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ fslug }, sp] = await Promise.all([params, searchParams]);
  const recipe = await getGlobalFeature(decodeURIComponent(fslug));
  if (recipe === null) notFound();

  const fm = recipe.frontmatter;
  const recipeUrl = `/recipes/global/${encodeURIComponent(recipe.slug)}`;

  return (
    <>
      <Topbar crumb={`global / Agent Recipes / ${recipe.slug}`} crumbPrefix="coodra / recipes" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · GLOBAL · AGENT RECIPE · {recipe.slug.toUpperCase()}</div>
            <h1 className="head__title">
              <em>{recipe.slug}</em>
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
              <strong>global scope</strong>
              <br />
              {formatBytes(recipe.bodyBytes)}
              <br />
              maturity: {fm.maturity ?? 'draft'}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/recipes/global">
                ← back to Global Recipes
              </Link>
              <Link className="btn" href={`${recipeUrl}/edit`}>
                Edit
              </Link>
            </div>
          </div>
        </div>

        {sp.saved !== undefined ? <Banner tone="ok">Global Agent Recipe saved.</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {recipe.warnings.length > 0 ? (
          <Banner tone="warn">
            <strong>Validation warnings ({recipe.warnings.length}):</strong>
            <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
              {recipe.warnings.map((warning) => (
                <li key={warning} style={{ marginBottom: 4 }}>
                  {warning}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <div className="dash-grid">
          <div>
            <div className="card__head" style={{ marginBottom: 16 }}>
              <h2 className="card__title">
                <em>recipe</em> body
              </h2>
              <span className="card__role">global</span>
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
              {recipe.body || <span style={{ color: 'var(--ink-mute)' }}>(empty body)</span>}
            </pre>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">Frontmatter</h3>
              </div>
              <dl style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.8, margin: 0 }}>
                <Field label="name" value={fm.name} />
                <Field label="maturity" value={fm.maturity ?? 'draft'} />
                {(fm.tags ?? []).length > 0 ? <Field label="tags" value={(fm.tags ?? []).join(', ')} /> : null}
                {(fm.owners ?? []).length > 0 ? <Field label="owners" value={(fm.owners ?? []).join(', ')} /> : null}
              </dl>
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
