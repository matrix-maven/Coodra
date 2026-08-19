import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listGlobalFeatures } from '@/lib/queries/features-list';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly removed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function GlobalFeaturesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [features, sp] = await Promise.all([listGlobalFeatures(), searchParams]);
  const published = features.filter((feature) => feature.status === 'published').length;
  const drafts = features.length - published;

  return (
    <>
      <Topbar crumb="Global Agent Recipes" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · KNOWLEDGE · GLOBAL AGENT RECIPES</div>
            <h1 className="head__title">
              Workspace recipes, <em>not tied to one repo</em>.
            </h1>
            <p className="head__lede">
              Global Agent Recipes are shared guidance for patterns that apply across projects. They are stored in
              Coodra&apos;s global scope and do not write into a selected project folder.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {features.length} global recipe{features.length === 1 ? '' : 's'}
              </strong>
              <br />
              {published} published · {drafts} draft
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/recipes">
                ← back to scopes
              </Link>
              <Link className="btn btn--accent" href="/recipes/global/new">
                + Add global recipe
              </Link>
            </div>
          </div>
        </div>

        {sp.removed !== undefined ? (
          <Banner tone="ok">
            Global Agent Recipe <code style={mono}>{sp.removed}</code> removed.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {features.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 28, marginBottom: 12 }}>
              No global recipes <em>yet</em>.
            </h2>
            <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-dim)', marginBottom: 24 }}>
              Create global recipes for workspace-wide habits. Use project recipes when the guidance depends on a repo,
              code paths, or supporting files.
            </p>
            <Link className="btn btn--accent" href="/recipes/global/new">
              + Add global recipe
            </Link>
          </div>
        ) : (
          <div className="dash-list" style={{ marginTop: 4 }}>
            {features.map((feature) => (
              <Link
                key={feature.id}
                className="row"
                href={`/recipes/global/${encodeURIComponent(feature.slug)}`}
                style={{ display: 'grid', textDecoration: 'none' }}
              >
                <div className={`row__dot ${feature.maturity === 'deprecated' ? 'row__dot--warn' : ''}`}></div>
                <div className="row__main">
                  <div className="row__title">
                    <em>{feature.slug}</em>
                    {feature.maturity !== null && feature.maturity !== 'stable' ? (
                      <span
                        style={{ marginLeft: 8, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}
                      >
                        · {feature.maturity}
                      </span>
                    ) : null}
                  </div>
                  <div className="row__sub" style={{ maxWidth: 720 }}>
                    {truncate(feature.description, 200)}
                  </div>
                </div>
                <div className="row__verdict">
                  <span className={`badge ${feature.status === 'published' ? 'badge--ok' : 'badge--caution'}`}>
                    <span className="badge__dot"></span>
                    {feature.status === 'published' ? 'PUBLISHED' : 'DRAFT'}
                  </span>
                </div>
                <div className="row__time">{formatRelative(feature.updatedAt)}</div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
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

function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  if (oneline.length <= max) return oneline;
  return `${oneline.slice(0, max - 1)}…`;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
