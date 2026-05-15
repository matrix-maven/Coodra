import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { tryGetActor } from '@/lib/auth';
import { listFeaturesAcrossProjects } from '@/lib/queries/features-list';
import { resolveClerkDisplayNames } from '@/lib/queries/clerk-users';

export const dynamic = 'force-dynamic';

/**
 * `/features` — Phase F.1.d. Cross-project listing of skill-style
 * features sourced from the DB layer (so cloud-pushed features land
 * here even before the puller writes them to disk).
 *
 * Distinct from `/packs`:
 *   - Feature packs are PUSH-at-SessionStart module blueprints.
 *   - Features (this page) are PULL-on-trigger skill recipes.
 *
 * The page deliberately leans into the "what just landed?" mental model
 * — sorted by `updated_at DESC`, status (draft/published) and author
 * front-and-centre so an admin can quickly tell "did my teammate's CLI
 * `feature add` make it across?".
 *
 * F.1.d is read-only. F.3.b layers in the draft → publish toggle and
 * the per-feature detail/edit pages.
 */

export default async function FeaturesPage() {
  const features = await listFeaturesAcrossProjects();
  const published = features.filter((f) => f.status === 'published').length;
  const drafts = features.length - published;

  // Phase F.6 — role-aware UI. Viewers see a clear "read-only" banner
  // and the upcoming "+ New feature" button is hidden for them.
  // Members and admins both see the (CLI-only) authoring hint.
  const actor = await tryGetActor();
  const role = actor?.role ?? 'admin';
  const isViewer = role === 'viewer';

  // Resolve Clerk display names for every author in the list so the
  // attribution column shows "Alice Lee" rather than "user_abc..." —
  // same pattern the decisions + context-packs pages use.
  const authorIds = Array.from(
    new Set(features.map((f) => f.createdByUserId).filter((id): id is string => id !== null)),
  );
  const displayNames = await resolveClerkDisplayNames(authorIds);

  return (
    <>
      <Topbar crumb="Features" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · KNOWLEDGE · FEATURES</div>
            <h1 className="head__title">
              Skill recipes the agent <em>pulls</em> on demand.
            </h1>
            <p className="head__lede">
              Features are on-demand skill recipes — small markdown documents the agent indexes at SessionStart and
              pulls only when a user prompt matches the feature's trigger description. The same pattern as Anthropic
              Skills. Pull model — never loaded blindly.
              <br />
              <span style={{ color: 'var(--ink-mute)', fontSize: 13 }}>
                Need always-loaded MODULE-level architectural context (spec / impl / techstack / meta)? Those are{' '}
                <strong>feature packs</strong>, not features — managed at{' '}
                <Link href="/packs" style={{ color: 'var(--accent)' }}>
                  /packs
                </Link>
                .
              </span>
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{features.length} features</strong>
              <br />
              {published} published · {drafts} draft
              <br />
              docs/features/
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/templates">
                Templates
              </Link>
              {/* Phase F.6 — Authoring hint is hidden for viewers
                  (they cannot author anything). Members + admins see
                  the CLI hint until web authoring lands. */}
              {!isViewer ? (
                <span
                  className="btn btn--ghost"
                  style={{ opacity: 0.55, cursor: 'not-allowed' }}
                  title="Author via `coodra feature add <slug>` on the CLI for now. Web authoring lands as a follow-on."
                >
                  + New feature (CLI)
                </span>
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
                  title="Viewers can browse every feature but cannot author or edit."
                >
                  Read-only · viewer role
                </span>
              )}
            </div>
          </div>
        </div>

        {features.length === 0 ? (
          <div className="empty">
            <strong>
              No features <em>yet</em>.
            </strong>
            Create one with{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
              coodra feature add &lt;slug&gt;
            </span>{' '}
            from any project root. In team mode the row appears here within ~10 seconds of the daemon's next sync tick.
          </div>
        ) : (
          <div className="pack-grid">
            {features.map((f) => {
              const status =
                f.status === 'published'
                  ? { label: 'PUBLISHED', cls: 'badge--ok' }
                  : { label: 'DRAFT', cls: 'badge--caution' };
              const maturityTag = f.maturity ?? 'unset';
              const authorName =
                f.createdByUserId === null
                  ? null
                  : displayNames.get(f.createdByUserId)?.label ?? f.createdByUserId.slice(0, 12);
              return (
                <div
                  key={f.id}
                  className="pack"
                  style={{ textDecoration: 'none', cursor: 'default' }}
                >
                  <div
                    className="pack__num"
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}
                  >
                    <span>/ {f.slug.toUpperCase()}</span>
                    <span className={`badge ${status.cls}`}>
                      <span className="badge__dot"></span>
                      {status.label}
                    </span>
                  </div>
                  <h3 className="pack__title">
                    <em>{f.projectSlug}</em> · {f.slug}
                  </h3>
                  <p className="pack__excerpt">{truncate(f.description, 220)}</p>
                  <div className="pack__meta">
                    <span style={{ color: 'var(--ink)' }}>● maturity: {maturityTag}</span>
                    <span style={{ color: 'var(--ink-mute)' }}>● {formatBytes(f.bodyBytes)}</span>
                    {authorName !== null ? (
                      <span style={{ color: 'var(--ink-mute)' }}>● {authorName}</span>
                    ) : null}
                    <span style={{ marginLeft: 'auto', color: 'var(--ink-mute)' }}>
                      {formatRelative(f.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
