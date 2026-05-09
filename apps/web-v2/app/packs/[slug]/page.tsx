import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { deletePackAction, regeneratePackAction } from '@/lib/actions/packs';
import { getPack } from '@/lib/queries/packs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly regenerated?: string;
  readonly edited?: string;
  readonly installed?: string;
  readonly uploaded?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const pack = getPack(decodeURIComponent(slug));
  if (pack === null) notFound();

  const cwd = process.cwd();

  return (
    <>
      <Topbar crumb={pack.slug} crumbPrefix="contextos / packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/04 · KNOWLEDGE · PACK · {pack.slug.toUpperCase()}</div>
            <h1 className="head__title">
              <em>{pack.slug}</em>.
            </h1>
            <p className="head__lede">
              Source · <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink-dim)' }}>{pack.dir}</span>
              {pack.parentSlug !== null ? (
                <>
                  {' · child of '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{pack.parentSlug}</span>
                </>
              ) : null}
            </p>
          </div>
          <div>
            <span className={`badge ${pack.isActive ? 'badge--ok' : ''}`}>
              <span className="badge__dot"></span>
              {pack.isActive ? 'ACTIVE' : 'OFF'}
            </span>
          </div>
        </div>

        {sp.regenerated !== undefined ? (
          <Banner tone="ok">Pack regenerated · spec / impl / techstack rewritten.</Banner>
        ) : null}
        {sp.edited !== undefined ? <Banner tone="ok">{sp.edited} saved.</Banner> : null}
        {sp.installed !== undefined ? <Banner tone="ok">Template {sp.installed} installed.</Banner> : null}
        {sp.uploaded !== undefined ? (
          <Banner tone="ok">
            Freeform pack uploaded · spec.md + meta.json written. Agent picks it up on next get_feature_pack.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {/* Action bar — regenerate + delete */}
        <div
          className="card"
          style={{
            padding: 20,
            marginBottom: 24,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--ink-mute)',
            }}
          >
            Pack actions
          </span>

          <form action={regeneratePackAction} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="hidden" name="projectSlug" value={pack.slug} />
            <input type="hidden" name="packSlug" value={pack.slug} />
            <input type="hidden" name="cwd" value={cwd} />
            <input type="hidden" name="confirm" value="yes" />
            <button className="btn btn--sm" type="submit" title="Re-render spec/impl/techstack from the markers">
              Regenerate
            </button>
          </form>

          <details style={{ position: 'relative' }}>
            <summary
              className="btn btn--sm btn--ghost"
              style={{ borderColor: 'var(--warn)', color: 'var(--warn)', listStyle: 'none', cursor: 'pointer' }}
            >
              Delete pack…
            </summary>
            <form
              action={deletePackAction}
              style={{
                marginTop: 12,
                padding: 14,
                border: '1px solid var(--warn)',
                background: 'var(--warn-glow)',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <input type="hidden" name="projectSlug" value={pack.slug} />
              <input type="hidden" name="packSlug" value={pack.slug} />
              <input type="hidden" name="cwd" value={cwd} />
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--warn)',
                  letterSpacing: '0.04em',
                }}
              >
                Type <strong>delete {pack.slug}</strong> to confirm
              </span>
              <input
                name="confirmation"
                placeholder={`delete ${pack.slug}`}
                required
                style={{
                  padding: '6px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--warn)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  flex: 1,
                  minWidth: 200,
                }}
              />
              <button
                className="btn btn--sm"
                type="submit"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
              >
                Delete
              </button>
            </form>
          </details>

          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
            cwd · {cwd}
          </span>
        </div>

        <PackSection title="Spec" body={pack.spec} />
        <PackSection title="Implementation" body={pack.implementation} />
        <PackSection title="Tech stack" body={pack.techstack} />
        <PackSection title="meta.json" body={pack.metaRaw} mono />
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

function PackSection({ title, body, mono }: { title: string; body: string | null; mono?: boolean }) {
  return (
    <div className="aside-card" style={{ marginBottom: 24 }}>
      <div className="aside-card__head">
        <h3 className="aside-card__title">{title}</h3>
        <span className="card__role">{body === null ? 'absent' : `${body.length} chars`}</span>
      </div>
      {body === null ? (
        <div style={{ fontSize: 13, color: 'var(--ink-dim)', fontFamily: 'var(--mono)' }}>— file not present —</div>
      ) : (
        <pre
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--rule)',
            padding: '18px 22px',
            fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
            fontSize: mono ? 11 : 13,
            lineHeight: mono ? 1.7 : 1.6,
            color: 'var(--ink)',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
            maxHeight: 480,
          }}
        >
          {body}
        </pre>
      )}
    </div>
  );
}
