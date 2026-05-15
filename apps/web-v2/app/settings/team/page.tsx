import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CopyLinkBox } from '@/components/CopyLinkBox';
import { Topbar } from '@/components/Topbar';
import { mintInviteAction } from '@/lib/actions/invite';
import { revokeInviteAction } from '@/lib/actions/revoke-invite';
import { getActor } from '@/lib/auth';
import { isClerkDevelopmentInstance } from '@/lib/clerk-env';
import { resolveDeploymentMode, resolveIdentityMode } from '@/lib/deployment-mode';
import { describeInviteSecretConfig } from '@/lib/invite-token';
import { isMissingTeamInvitesTableError } from '@/lib/postgres-errors';
import { isDeploymentBaseUrlUnset, resolveDeploymentBaseUrl } from '@/lib/public-url';
import { listPendingInvites, type TeamInviteRow } from '@/lib/queries/invites';
import { resolveClerkDisplayNames } from '@/lib/queries/clerk-users';
import { listTeamMembers } from '@/lib/queries/team-members';
import { readTeamConfig } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

/**
 * `/settings/team` — admin's view of the active team configuration.
 *
 * Reads:
 *   1. `~/.coodra/config.json::team` — clerkUserId / clerkOrgId / hookSecret hash / joinedAt.
 *   2. `pending_jobs` (via dashboard's pattern) — sync queue depth.
 *   3. The audit-table union — distinct `created_by_user_id` set (members observed locally).
 *
 * Solo mode 404s — there's no team to manage. The welcome page has the
 * upgrade affordance.
 *
 * Why two member sources (Clerk + local audit): Clerk is the identity
 * authority but a member who joined the org but never ran an agent
 * session won't appear in the local audit. The "observed locally" list
 * is therefore a strict subset of Clerk's org membership — useful for
 * answering "who's actually using Coodra." A future enhancement
 * loads the full Clerk org member list via `clerkClient` and shows
 * inactive members as faded rows.
 */

interface SearchParams {
  readonly invited?: string;
  readonly token?: string;
  readonly revoked?: string;
  readonly error?: string;
  readonly clerkWarning?: string;
}

export default async function TeamSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const dm = resolveDeploymentMode();
  // Phase G slice G.8 — the invite-minting + pending-invites UI works
  // in any team mode (laptop OR cloud). Pre-Phase-G this was gated on
  // 'team-hosted' only, leaving local-team users stuck with the legacy
  // flag-based "team join" flow shown in the screenshot.
  const isTeamMode = resolveIdentityMode() === 'team';
  if (dm === 'local-solo') notFound();
  const sp = await searchParams;

  // Three identity-source scenarios for this page:
  //
  //   local-team   — read team block from ~/.coodra/config.json
  //   team-hosted  — read team identity from Clerk session + env-pinned
  //                  COODRA_EXPECTED_ORG_ID. No ~/.coodra on the
  //                  deployment server.
  //
  // Both produce the same `team` shape so the rest of the page renders
  // uniformly. The "secret hint" + "joinedAt" only show in local-team
  // — those concepts don't apply on a hosted deployment.
  let team: {
    readonly clerkUserId: string;
    readonly clerkOrgId: string;
    readonly clerkOrgSlug: string | undefined;
    readonly localHookSecret: string | null;
    readonly joinedAt: number | null;
  };

  if (dm === 'local-team') {
    const cfg = readTeamConfig();
    if (cfg.mode !== 'team' || cfg.team === undefined) notFound();
    team = {
      clerkUserId: cfg.team.clerkUserId,
      clerkOrgId: cfg.team.clerkOrgId,
      clerkOrgSlug: cfg.team.clerkOrgSlug,
      localHookSecret: cfg.team.localHookSecret,
      joinedAt: cfg.team.joinedAt,
    };
  } else {
    // team-hosted: identity comes from Clerk session (verified JWT).
    // The middleware already redirected unauthenticated requests; here
    // we trust that getActor() returns a real session.
    const actor = await getActor();
    team = {
      clerkUserId: actor.userId,
      clerkOrgId: actor.orgId,
      clerkOrgSlug: undefined,
      localHookSecret: null,
      joinedAt: null,
    };
  }

  const members = await listTeamMembers().catch((err) => {
    console.error('[settings/team] listTeamMembers threw:', err);
    return [] as Awaited<ReturnType<typeof listTeamMembers>>;
  });

  // Resolve every member's Clerk display name (full name or email) once
  // per render. Pre-fix the table showed raw `user_2nKj…` ids for
  // teammates other than the viewer — accurate but unreadable. Post-fix
  // each row shows the member's name / email when Clerk knows them.
  const memberDisplayNames = await resolveClerkDisplayNames(members.map((m) => m.userId));

  // Phase G — pending invites + HMAC-secret precondition apply in any
  // team mode (laptop OR cloud). Pre-Phase-G this was gated on
  // 'team-hosted' only, hiding the invite flow on local-team admins.
  let pendingInvites: TeamInviteRow[] = [];
  let schemaNotMigrated = false;
  if (isTeamMode) {
    try {
      pendingInvites = await listPendingInvites(team.clerkOrgId);
    } catch (err) {
      // Surface a distinct banner state for the "Phase 2 migration not
      // applied yet" case so the admin sees a clear remediation step
      // instead of an empty pending-invites table that silently hides
      // the precondition.
      if (isMissingTeamInvitesTableError(err)) {
        schemaNotMigrated = true;
      } else {
        console.error('[settings/team] listPendingInvites threw:', err);
      }
    }
  }
  const inviteSecretIssue = isTeamMode ? describeInviteSecretConfig() : null;
  const baseUrl = resolveDeploymentBaseUrl();
  const baseUrlUnset = isDeploymentBaseUrlUnset();
  const inviteLinkFromMint =
    sp.token !== undefined && sp.token.length > 0 ? `${baseUrl}/install/${sp.token}` : null;
  const joinedAtIso = team.joinedAt !== null ? new Date(team.joinedAt).toISOString() : '(team-hosted — managed in Clerk)';
  const secretHint =
    team.localHookSecret !== null
      ? `${team.localHookSecret.slice(0, 6)}…${team.localHookSecret.slice(-4)} · ${team.localHookSecret.length} chars`
      : '(team-hosted deployment — local hook secret is not present on this server)';
  const databaseUrl = process.env.DATABASE_URL ?? '(not visible to web — set in COODRA_HOME/.env)';
  const databaseUrlMasked = maskDatabaseUrl(databaseUrl);

  return (
    <>
      <Topbar crumb="Team settings" crumbPrefix="coodra / settings" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · SYSTEM · TEAM</div>
            <h1 className="head__title">
              Team <em>workspace</em>.
            </h1>
            <p className="head__lede">
              The team config block on this machine — what credentials it carries, when it joined, who it’s observed
              locally. Member identities are managed in Clerk; Coodra reads this view to scope and attribute writes.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{members.length} active</strong>
              <br />
              {team.joinedAt !== null ? `joined ${fmtDate(team.joinedAt)}` : 'hosted deployment'}
              <br />
              {team.clerkOrgSlug ?? team.clerkOrgId.slice(0, 16)}…
            </div>
            <div className="head__actions">
              <Link href="/onboarding/team" className="btn btn--ghost">
                Reconfigure
              </Link>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 36 }}>
          <ConfigCard
            title={
              <>
                Clerk <em>identity</em>
              </>
            }
            rows={[
              { k: 'Org id', v: team.clerkOrgId, mono: true },
              { k: 'Org slug', v: team.clerkOrgSlug ?? '—', mono: true },
              { k: 'Your user id', v: team.clerkUserId, mono: true },
              { k: 'Joined', v: joinedAtIso, mono: true },
            ]}
          />
          <ConfigCard
            title={
              <>
                Cloud <em>connection</em>
              </>
            }
            rows={[
              { k: 'Database', v: databaseUrlMasked, mono: true },
              { k: 'Local hook secret', v: secretHint, mono: true },
              { k: 'Mode', v: 'team', mono: true },
              {
                k: 'Sync direction',
                v: 'local SQLite ⇄ cloud Postgres (push + pull every 10s)',
              },
            ]}
          />
        </div>

        {dm === 'local-team' ? <LeaveTeamCard orgLabel={team.clerkOrgSlug ?? team.clerkOrgId} /> : null}

        <div className="card" style={{ padding: 0 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              padding: '24px 28px',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            <h2 className="card__title">
              Members <em>observed</em> locally
            </h2>
            <span className="card__role">{members.length} unique authors · audit union</span>
          </div>

          {members.length === 0 ? (
            <div
              style={{
                padding: '48px 28px',
                textAlign: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--ink-mute)',
                letterSpacing: '0.04em',
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: 18 }}>
                No attributed writes yet.
              </strong>
              <br />
              Once teammates run <code style={inlineMono}>coodra start</code> and use Claude Code, their writes
              appear here within seconds. The sync daemon pulls cloud rows from teammates every 10s.
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 18 }}></th>
                  <th>User</th>
                  <th>Runs</th>
                  <th>Decisions</th>
                  <th>Packs</th>
                  <th>Policies</th>
                  <th>Feature packs</th>
                  <th style={{ textAlign: 'right' }}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isYou = m.userId === team.clerkUserId;
                  const resolved = memberDisplayNames.get(m.userId);
                  const displayLabel = resolved?.label ?? shortenUserId(m.userId);
                  return (
                    <tr key={m.userId}>
                      <td>
                        <span className="row__dot"></span>
                      </td>
                      <td>
                        <div className="tbl__title">
                          {isYou ? (
                            <>
                              <em>You</em>
                              {resolved !== undefined ? (
                                <span style={{ marginLeft: 8, color: 'var(--ink-dim)', fontWeight: 400 }}>
                                  · {resolved.label}
                                </span>
                              ) : null}
                            </>
                          ) : (
                            <>{displayLabel}</>
                          )}
                        </div>
                        <div className="tbl__mono">
                          {resolved?.email !== null && resolved?.email !== undefined ? `${resolved.email} · ` : ''}
                          {m.userId}
                        </div>
                      </td>
                      <td className="tbl__mono">{m.perTable.runs}</td>
                      <td className="tbl__mono">{m.perTable.decisions}</td>
                      <td className="tbl__mono">{m.perTable.contextPacks}</td>
                      <td className="tbl__mono">{m.perTable.policies}</td>
                      <td className="tbl__mono">{m.perTable.featurePacks}</td>
                      <td className="tbl__mono" style={{ textAlign: 'right' }}>
                        {fmtRelative(m.lastSeenAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* M04 Phase 2 — Clerk dev-mode warning (sticky; informational,
            not blocking). Verified Clerk policy: test keys do not send
            real invitation emails. Surface so admins don't wait on an
            email that's never coming. */}
        {dm === 'team-hosted' && isClerkDevelopmentInstance() ? (
          <div style={{ ...bannerWarn, marginTop: 16 }}>
            <strong>Clerk is running in development mode.</strong>
            <br />
            Test keys (<code style={inlineMono}>sk_test_…</code>) do not deliver real invitation emails. Each
            invite you generate below is still valid — just share the link directly via Slack / 1Password
            instead of relying on Clerk to email it. To send real emails, deploy your Clerk app to production
            and swap the keys to <code style={inlineMono}>sk_live_…</code> / <code style={inlineMono}>pk_live_…</code>.
          </div>
        ) : null}

        {/* M04 Phase 2 — schema-not-migrated banner (highest priority,
            blocks the invite UI until the admin runs the migration). */}
        {schemaNotMigrated ? (
          <div style={bannerWarn}>
            <strong>Migration 0014_team_invites is not applied yet.</strong>
            <br />
            The `team_invites` table is missing on this deployment's Postgres. Run{' '}
            <code style={inlineMono}>coodra db migrate</code> against your DATABASE_URL, then reload this page.
            The invite form below is disabled until that completes.
          </div>
        ) : null}

        {/* M04 Phase 2 — banners for invite minting / revoke / errors. */}
        {sp.invited !== undefined ? (
          <div style={bannerOk} id="invite-banner">
            Invite sent to <strong style={{ color: 'var(--ink)' }}>{sp.invited}</strong>.
            {inviteLinkFromMint !== null ? (
              <>
                {' '}This link is single-use and shown ONCE — copy it now if you need to share it directly
                (e.g. when running against Clerk test keys, or if the email didn't arrive).
                <CopyLinkBox url={inviteLinkFromMint} />
              </>
            ) : null}
          </div>
        ) : null}
        {sp.revoked !== undefined ? (
          <div style={bannerOk}>Revoked invite for {sp.revoked}.</div>
        ) : null}
        {sp.error !== undefined ? <div style={bannerWarn}>{sp.error}</div> : null}
        {sp.clerkWarning !== undefined ? (
          <div style={bannerWarn}>
            <strong>Local row was saved, but Clerk did not send the email:</strong>
            <br />
            {sp.clerkWarning}
            <br />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, opacity: 0.8 }}>
              You can still copy the invite link above and share it directly. Or revoke this invite and retry.
            </span>
          </div>
        ) : null}

        <div style={{ marginTop: 36, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }} id="invite">
          {isTeamMode ? (
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Invite <em>teammate</em>
              </h3>
              {schemaNotMigrated ? (
                <div style={{ ...bannerWarn, marginBottom: 0 }}>
                  <strong>Schema not migrated.</strong>
                  <br />
                  Run <code style={inlineMono}>coodra db migrate</code> first. See the banner at the top of
                  the page.
                </div>
              ) : inviteSecretIssue !== null ? (
                <div style={{ ...bannerWarn, marginBottom: 0 }}>
                  <strong>Configure invite secret first.</strong>
                  <br />
                  {inviteSecretIssue}
                </div>
              ) : (
                <>
                  {baseUrlUnset ? (
                    <div style={{ ...bannerWarn, marginBottom: 12 }}>
                      <strong>Set COODRA_PUBLIC_URL</strong> in deployment env so generated invite links
                      point at this deployment's external URL. Without it, links will contain a placeholder.
                    </div>
                  ) : null}
                  <form action={mintInviteAction} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={inviteLabel}>
                      <span>Email</span>
                      <input
                        type="email"
                        name="email"
                        required
                        placeholder="alice@acme.com"
                        style={inviteInput}
                        autoComplete="off"
                      />
                    </label>
                    <label style={inviteLabel}>
                      <span>Role</span>
                      <select name="role" defaultValue="member" style={inviteInput}>
                        <option value="viewer">viewer · read-only</option>
                        <option value="member">member · default</option>
                        <option value="admin">admin · full</option>
                      </select>
                    </label>
                    <label style={inviteLabel}>
                      <span>Expires in</span>
                      <select name="expiresInDays" defaultValue="7" style={inviteInput}>
                        <option value="1">24 hours</option>
                        <option value="7">7 days</option>
                        <option value="14">14 days</option>
                        <option value="30">30 days</option>
                      </select>
                    </label>
                    <button type="submit" className="btn btn--accent" style={{ marginTop: 6 }}>
                      Generate invite link
                    </button>
                  </form>
                  <p style={{ marginTop: 12, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)', lineHeight: 1.65 }}>
                    {isClerkDevelopmentInstance() ? (
                      <>
                        The link is single-use, 7-day expiry by default, bound to the email above. Redemption
                        requires the invitee to be a member of the Clerk org. <strong style={{ color: 'var(--warn)' }}>
                        Clerk test keys do not send emails</strong> — copy the link from the success banner and
                        share it directly (Slack / 1Password), or add the user to the org from your Clerk dashboard.
                      </>
                    ) : (
                      <>
                        Clerk emails the invitee; the link is single-use, 7-day expiry by default, bound to the
                        email above. Redemption requires the invitee to have completed Clerk sign-up + accepted
                        the org invite (both handled by Clerk's hosted email flow). Revoke any pending invite below.
                      </>
                    )}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Add <em>another teammate</em>
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 14 }}>
                Share the credential block with them via 1Password / Bitwarden / Vault. They run one CLI command:
              </p>
            <pre
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--rule)',
                padding: '14px 18px',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink)',
                letterSpacing: '0.04em',
                lineHeight: 1.7,
                overflowX: 'auto',
              }}
            >
{`coodra team join \\
  --user-id <their-clerk-user-id> \\
  --org-id ${team.clerkOrgId} \\
  --secret <hook-secret-from-onboarding> \\
  --database-url '<your-db-url>'`}
            </pre>
            <p style={{ marginTop: 12, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--caution)' }}>
              The hook secret is shown only at <code style={inlineMono}>coodra team setup</code> time. We don’t store
              it readable here. If you’ve lost it, re-run setup with the same DB URL — it generates a new secret.
            </p>
            </div>
          )}

          {dm === 'team-hosted' ? (
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Manage in <em>Clerk</em>
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 14 }}>
                Add/remove members, change roles, rotate org settings — all in your Clerk dashboard. Coodra
                consumes Clerk's org membership read-only; we don't mirror or override it.
              </p>
              <a
                href="https://dashboard.clerk.com"
                target="_blank"
                rel="noreferrer"
                className="btn"
                style={{ display: 'inline-block' }}
              >
                Open Clerk dashboard
              </a>
              <p style={{ marginTop: 12, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)' }}>
                Removing someone from the Clerk org makes their next sign-in fail (org-mismatch redirect to
                /forbidden). Their existing audit rows stay — append-only by design (ADR-007).
              </p>
            </div>
          ) : (
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                <em>Leave</em> the team
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 14 }}>
                Demotes this machine back to solo. Removes <code style={inlineMono}>config.json::team</code> + the four
                team env keys. Local audit history stays — you can copy it elsewhere or delete{' '}
                <code style={inlineMono}>~/.coodra/data.db</code> manually.
              </p>
              <pre
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  padding: '14px 18px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--ink)',
                  letterSpacing: '0.04em',
                }}
              >
coodra team leave
              </pre>
              <p style={{ marginTop: 12, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)' }}>
                Your cloud Postgres is untouched — your teammates keep using it. The Postgres project lives in your
                Supabase account; pause or delete it from the Supabase dashboard if you’re shutting down the team.
              </p>
            </div>
          )}
        </div>

        {/* Pending invites table — Phase G: any team mode (laptop or cloud). */}
        {isTeamMode ? (
          <div className="card" style={{ padding: 0, marginTop: 36 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                padding: '24px 28px',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              <h2 className="card__title">
                Pending <em>invites</em>
              </h2>
              <span className="card__role">{pendingInvites.length} pending</span>
            </div>
            {pendingInvites.length === 0 ? (
              <div
                style={{
                  padding: '32px 28px',
                  textAlign: 'center',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  color: 'var(--ink-mute)',
                }}
              >
                No pending invites. Use the form above to invite a teammate.
              </div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th>Invited by</th>
                    <th style={{ textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingInvites.map((inv) => (
                    <tr key={inv.id}>
                      <td className="tbl__title">{inv.email}</td>
                      <td className="tbl__mono">{inv.role}</td>
                      <td className="tbl__mono">{fmtRelative(inv.expiresAt)}</td>
                      <td className="tbl__mono">{shortenUserId(inv.invitedByUserId)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <form action={revokeInviteAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="jti" value={inv.jti} />
                          <button className="btn btn--sm btn--ghost" type="submit">
                            Revoke
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}

function ConfigCard({
  title,
  rows,
}: {
  readonly title: React.ReactNode;
  readonly rows: ReadonlyArray<{ readonly k: string; readonly v: string; readonly mono?: boolean }>;
}) {
  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">{title}</h2>
        <span className="card__role">read-only</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.k}
          style={{
            display: 'grid',
            gridTemplateColumns: '160px 1fr',
            gap: 16,
            padding: '14px 0',
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--rule)',
            alignItems: 'baseline',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.2em',
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
            }}
          >
            {r.k}
          </div>
          <div
            style={{
              fontFamily: r.mono === true ? 'var(--mono)' : 'var(--sans)',
              fontSize: r.mono === true ? 11 : 13,
              color: 'var(--ink)',
              letterSpacing: r.mono === true ? '0.04em' : 'normal',
              wordBreak: 'break-all',
              lineHeight: 1.6,
            }}
          >
            {r.v}
          </div>
        </div>
      ))}
    </div>
  );
}

function shortenUserId(id: string): string {
  // user_2nKj…XYZ — collapse the noisy middle chunk.
  if (id.length <= 16) return id;
  return `${id.slice(0, 9)}…${id.slice(-4)}`;
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffSec = Math.floor((Date.now() - t) / 1000);
  // Past timestamps → "Xm ago" / "Xh ago" / "Xd ago".
  if (diffSec >= 0) {
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return `${Math.floor(diffSec / 86400)}d ago`;
  }
  // Future timestamps → "in Xh" / "in Xd". Invite-row "expires_at"
  // lives in the future; the un-clamped formula above produced
  // misleading negative strings ("-604052s ago") in earlier renders.
  const future = -diffSec;
  if (future < 60) return `in ${future}s`;
  if (future < 3600) return `in ${Math.floor(future / 60)}m`;
  if (future < 86400) return `in ${Math.floor(future / 3600)}h`;
  return `in ${Math.floor(future / 86400)}d`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function maskDatabaseUrl(url: string): string {
  return url.replace(/:[^:@/]+@/, ':***@');
}

const inlineMono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--accent)',
  background: 'var(--bg)',
  padding: '1px 6px',
  border: '1px solid var(--rule)',
};

const bannerOk: React.CSSProperties = {
  padding: '12px 16px',
  marginTop: 16,
  marginBottom: 0,
  border: '1px solid var(--accent)',
  background: 'var(--accent-glow)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--accent)',
  letterSpacing: '0.08em',
  lineHeight: 1.6,
};

const bannerWarn: React.CSSProperties = {
  padding: '12px 16px',
  marginTop: 16,
  marginBottom: 0,
  border: '1px solid var(--warn)',
  background: 'var(--warn-glow)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--warn)',
  letterSpacing: '0.08em',
  lineHeight: 1.6,
};

const inviteLabel: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px 1fr',
  gap: 12,
  alignItems: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.18em',
  color: 'var(--ink-mute)',
  textTransform: 'uppercase',
};

const inviteInput: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '8px 10px',
  letterSpacing: '0.04em',
};

/**
 * Note: the signed invite token is shown to the admin exactly ONCE,
 * right after mint, via the `?token=...` redirect query. We deliberately
 * don't persist the signed token in `team_invites` — only the jti.
 * That way a SQL-injection or leaked-backup attacker who reads the
 * row can't redeem the invite; redemption requires the signed token,
 * which the admin saw briefly and either captured (paste into email)
 * or didn't (revoke + re-mint). This is the standard one-time-show
 * pattern for sensitive credentials (Clerk, GitHub PAT, AWS access keys
 * all do the same).
 */

/**
 * Phase C (clarity-pass-plan, 2026-05-11) — the local-team variant of
 * `/settings/team` carries a "Leave team" card that explains what the
 * CLI command does, what stays, what goes — and surfaces the exact
 * shell command. The web cannot execute the leave itself: leaving the
 * team is a laptop-state operation (mutates ~/.coodra/config.json
 * + .env on the developer's machine), and the local web variant
 * doesn't have a privileged shell channel to do that on the
 * developer's behalf. So the card is documentation + a copy block.
 */
function LeaveTeamCard({ orgLabel }: { readonly orgLabel: string }) {
  return (
    <div className="card" style={{ padding: 28, marginBottom: 36, borderColor: 'var(--warn)' }}>
      <div className="card__head" style={{ marginBottom: 16 }}>
        <h2 className="card__title">
          Leave <em>this team</em>
        </h2>
        <span className="card__role">laptop-local operation</span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 18 }}>
        Demote this machine back to solo mode. Your past contributions stay on the team — only this laptop's
        configuration changes. The web cannot execute this for you; run the command in your terminal.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 18,
          marginBottom: 22,
          padding: '14px 18px',
          background: 'var(--bg)',
          border: '1px solid var(--rule)',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--ink-mute)',
              marginBottom: 8,
            }}
          >
            What gets removed
          </div>
          <ul style={{ fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
            <li>~/.coodra/config.json team block (mode → solo)</li>
            <li>~/.coodra/.env: COODRA_MODE, DATABASE_URL, LOCAL_HOOK_SECRET, COODRA_TEAM_ORG_ID</li>
            <li>sync-daemon stops spawning on next `coodra start`</li>
          </ul>
        </div>
        <div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--ink-mute)',
              marginBottom: 8,
            }}
          >
            What stays
          </div>
          <ul style={{ fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
            <li>local SQLite rows (runs, decisions, packs) — historical state intact</li>
            <li>cloud rows — other team members continue to see them</li>
            <li>per-project .coodra.json files (unchanged)</li>
          </ul>
        </div>
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 8,
        }}
      >
        Run in your terminal
      </div>
      <pre
        style={{
          margin: 0,
          padding: '14px 18px',
          background: 'var(--bg)',
          border: '1px solid var(--rule)',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          color: 'var(--ink)',
          overflowX: 'auto',
        }}
      >
        coodra team leave
      </pre>
      <p style={{ fontSize: 11, color: 'var(--ink-mute)', lineHeight: 1.6, marginTop: 14, marginBottom: 0 }}>
        The CLI will prompt for a typed confirmation (
        <code style={{ fontFamily: 'var(--mono)' }}>leave {orgLabel}</code>) before it changes anything. Add{' '}
        <code style={{ fontFamily: 'var(--mono)' }}>--yes</code> to skip the prompt (CI / automation only). After
        leave, run <code style={{ fontFamily: 'var(--mono)' }}>coodra stop &amp;&amp; coodra start</code> so
        the daemons pick up solo-mode env, then <code style={{ fontFamily: 'var(--mono)' }}>coodra doctor --fix</code>{' '}
        to clean any stale COODRA_MODE lines in project .env files.
      </p>
    </div>
  );
}

