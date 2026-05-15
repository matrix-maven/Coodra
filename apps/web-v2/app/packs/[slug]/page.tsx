import { notFound } from 'next/navigation';

import { eq } from 'drizzle-orm';

import { sqliteSchema } from '@coodra/db';

import { Topbar } from '@/components/Topbar';
import { deletePackAction, regeneratePackAction, togglePackStatusAction } from '@/lib/actions/packs';
import { tryGetActor } from '@/lib/auth';
import { createWebDb } from '@/lib/db';
import { getPack } from '@/lib/queries/packs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly regenerated?: string;
  readonly edited?: string;
  readonly installed?: string;
  readonly uploaded?: string;
  readonly error?: string;
  readonly errorMessage?: string;
  readonly statusFlipped?: 'draft' | 'published';
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
  const pack = await getPack(decodeURIComponent(slug));
  if (pack === null) notFound();

  const cwd = process.cwd();

  // Phase F.3.b — look up the DB row to render the draft/published
  // badge and gate the toggle UI. Defaults to 'published' when the
  // DB row doesn't exist yet (the MCP-side lazy-sync will bootstrap
  // it on the next get_feature_pack call).
  const dbHandle = createWebDb();
  const dbRow =
    dbHandle.kind === 'sqlite'
      ? (
          await dbHandle.db
            .select({ status: sqliteSchema.featurePacks.status, id: sqliteSchema.featurePacks.id })
            .from(sqliteSchema.featurePacks)
            .where(eq(sqliteSchema.featurePacks.slug, pack.slug))
            .limit(1)
        )[0]
      : undefined;
  const packStatus: 'draft' | 'published' = dbRow?.status === 'draft' ? 'draft' : 'published';

  // Phase F.6 — actor + role for permission gating. Falls back to admin
  // when actor is unresolvable (local modes give admin by default; see
  // SOLO_ACTOR + the local-team branch of getActor()).
  const actor = await tryGetActor();
  const role = actor?.role ?? 'admin';
  const isAdmin = role === 'admin';
  const isViewer = role === 'viewer';

  return (
    <>
      <Topbar crumb={pack.slug} crumbPrefix="coodra / packs" />
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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <span className={`badge ${pack.isActive ? 'badge--ok' : ''}`}>
              <span className="badge__dot"></span>
              {pack.isActive ? 'ACTIVE' : 'OFF'}
            </span>
            <span className={`badge ${packStatus === 'published' ? 'badge--ok' : 'badge--caution'}`}>
              <span className="badge__dot"></span>
              {packStatus === 'published' ? 'PUBLISHED' : 'DRAFT'}
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
        {sp.statusFlipped !== undefined ? (
          <Banner tone="ok">
            Pack status flipped → <strong>{sp.statusFlipped}</strong>.
            {sp.statusFlipped === 'draft'
              ? ' Drafts are hidden from agent contexts (MCP get_feature_pack returns slug_not_found).'
              : ' The pack is now agent-visible; teammates will see it on next pull.'}
          </Banner>
        ) : null}

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

          {!isViewer ? (
            <form action={regeneratePackAction} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="hidden" name="projectSlug" value={pack.slug} />
              <input type="hidden" name="packSlug" value={pack.slug} />
              <input type="hidden" name="cwd" value={cwd} />
              <input type="hidden" name="confirm" value="yes" />
              <button className="btn btn--sm" type="submit" title="Re-render spec/impl/techstack from the markers">
                Regenerate
              </button>
            </form>
          ) : null}

          {/* Phase F.6 — Publish/Demote is admin-only. Members can
              author content (via regenerate) but only admins gate
              agent visibility. Viewers see neither button. */}
          {isAdmin ? (
            <form action={togglePackStatusAction} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="hidden" name="slug" value={pack.slug} />
              <button
                className="btn btn--sm"
                type="submit"
                title={
                  packStatus === 'published'
                    ? 'Hide from agent contexts (MCP get_feature_pack will return slug_not_found). The filesystem files stay; only the agent-visible status flips.'
                    : 'Make agent-visible. Teammates will pull the published pack on the next sync tick.'
                }
                style={
                  packStatus === 'draft'
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                    : undefined
                }
              >
                {packStatus === 'published' ? 'Move to draft' : 'Publish'}
              </button>
            </form>
          ) : null}

          {/* Phase F.6 — Delete is admin-only (mirror of policy in
              actions/packs.ts::deletePackAction). Members/viewers see
              no Delete button; if they need to delete, an admin must
              do it for them. */}
          {isAdmin ? (
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
          ) : null}

          {/* Phase F.6 — viewer banner so the read-only state is
              obvious. Members see no banner since they retain author
              rights on their own packs. */}
          {isViewer ? (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.04em',
                color: 'var(--ink-mute)',
                padding: '4px 8px',
                border: '1px dashed var(--ink-mute)',
                borderRadius: 4,
              }}
              title="Viewers can read every pack but cannot author, edit, publish, or delete."
            >
              Read-only · viewer role
            </span>
          ) : null}

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
