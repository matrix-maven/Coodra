import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { listPacks } from '@/lib/queries/packs';

export const dynamic = 'force-dynamic';

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string; uploaded?: string }>;
}) {
  const sp = await searchParams;
  const packs = listPacks();
  const synced = packs.filter((p) => p.fileCount === 4).length;
  const partial = packs.filter((p) => p.fileCount > 0 && p.fileCount < 4).length;

  return (
    <>
      <Topbar crumb="Feature packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/04 · KNOWLEDGE · FEATURE PACKS</div>
            <h1 className="head__title">
              Three voices: <em>spec</em>, plan, stack.
            </h1>
            <p className="head__lede">
              A feature pack is the durable record of a module: the why, the how, the dependency graph. Auto-injected on
              SessionStart. Edit on disk; we sync the metadata.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{packs.length} packs</strong>
              <br />
              {synced} synced · {partial} partial
              <br />
              docs/feature-packs/
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/templates">
                Templates
              </Link>
              <Link className="btn btn--accent" href="/packs/new">
                + Upload pack
              </Link>
            </div>
          </div>
        </div>

        {sp.deleted !== undefined ? <div className="banner banner--ok">Pack deleted · {sp.deleted}</div> : null}
        {sp.uploaded !== undefined ? (
          <div className="banner banner--ok">Pack uploaded · the agent will load it on the next get_feature_pack.</div>
        ) : null}

        {packs.length === 0 ? (
          <div className="empty">
            <strong>
              No packs <em>found</em>.
            </strong>
            Create{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>docs/feature-packs/&lt;slug&gt;/</span>{' '}
            in any project root and refresh.
          </div>
        ) : (
          <div className="pack-grid">
            {packs.map((p) => {
              const fileBadges: Array<{ label: string; ok: boolean }> = [
                { label: 'spec.md', ok: p.hasSpec },
                { label: 'impl.md', ok: p.hasImplementation },
                { label: 'stack.md', ok: p.hasTechstack },
                { label: 'meta.json', ok: p.hasMeta },
              ];
              const status =
                p.fileCount === 4
                  ? { label: 'SYNCED', cls: 'badge--ok' }
                  : p.fileCount === 0
                    ? { label: 'EMPTY', cls: 'badge--warn' }
                    : { label: `${p.fileCount}/4`, cls: 'badge--caution' };
              return (
                <Link
                  key={p.slug}
                  href={`/packs/${encodeURIComponent(p.slug)}`}
                  className="pack"
                  style={{ textDecoration: 'none' }}
                >
                  <div
                    className="pack__num"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                  >
                    <span>/ {p.slug.toUpperCase()}</span>
                    <span className={`badge ${status.cls}`}>
                      <span className="badge__dot"></span>
                      {status.label}
                    </span>
                  </div>
                  <h3 className="pack__title">
                    {p.parentSlug !== null ? (
                      <>
                        <em>{p.parentSlug}</em> · {p.slug}
                      </>
                    ) : (
                      <>
                        Pack · <em>{p.slug}</em>
                      </>
                    )}
                  </h3>
                  <p className="pack__excerpt">
                    {p.parentSlug !== null ? `Child of ${p.parentSlug}. ` : ''}
                    {p.fileCount} of 4 files present · {p.isActive ? 'active' : 'inactive'}.
                  </p>
                  <div className="pack__meta">
                    {fileBadges.map((b) => (
                      <span
                        key={b.label}
                        style={{
                          color: b.ok ? 'var(--ink)' : 'var(--ink-mute)',
                          opacity: b.ok ? 1 : 0.5,
                        }}
                      >
                        {b.ok ? '●' : '○'} {b.label}
                      </span>
                    ))}
                    <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>OPEN →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
