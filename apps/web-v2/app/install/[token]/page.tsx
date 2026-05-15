import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { resolveIdentityMode } from '@/lib/deployment-mode';
import { verifyInviteToken } from '@/lib/invite-token';
import { isMissingTeamInvitesTableError } from '@/lib/postgres-errors';
import { isDeploymentBaseUrlUnset, resolveDeploymentBaseUrl } from '@/lib/public-url';
import { getInviteByJti } from '@/lib/queries/invites';

export const dynamic = 'force-dynamic';

/**
 * `/install/[token]` — the post-Clerk-invitation landing page.
 *
 * Flow:
 *   1. Token preview (signature + expiry + revocation + redemption
 *      state) decided server-side before render.
 *   2. If invalid → show one of four explanatory cards (bad sig,
 *      expired, revoked, already redeemed).
 *   3. If valid → show two cards:
 *        • "Just browse" — for PMs / viewers. CTA → /. Token NOT
 *          burned (web join is Clerk's responsibility; token is only
 *          consumed by the CLI redeem endpoint).
 *        • "I'll run AI agents on my laptop" — reveals the one-line
 *          installer. Running it consumes the token.
 *
 * Caveat C from the design: the page itself never consumes the token.
 * `POST /api/install/[token]` is the only redemption surface, and that
 * fires from the CLI. So a teammate who picks "just browse" can later
 * come back and run the CLI installer with the same URL.
 *
 * The page is a public route per `middleware.ts::isPublic`. The redeem
 * endpoint is the security boundary, not the page.
 */

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
}

type Preview =
  | { readonly kind: 'ok'; readonly email: string; readonly role: 'admin' | 'member' | 'viewer'; readonly expiresAt: string; readonly orgId: string }
  | { readonly kind: 'expired'; readonly expiredAt: string }
  | { readonly kind: 'revoked'; readonly revokedAt: string }
  | { readonly kind: 'already_redeemed'; readonly usedAt: string }
  | { readonly kind: 'bad_signature' }
  | { readonly kind: 'bad_payload'; readonly detail: string }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'secret_misconfigured'; readonly detail: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'schema_not_migrated'; readonly detail: string };

async function buildPreview(token: string): Promise<Preview> {
  const verification = verifyInviteToken(token, Math.floor(Date.now() / 1000));
  if (!verification.ok) {
    if (verification.reason === 'expired') return { kind: 'expired', expiredAt: 'recently' };
    if (verification.reason === 'bad_signature') return { kind: 'bad_signature' };
    if (verification.reason === 'malformed') return { kind: 'malformed' };
    if (verification.reason === 'secret_misconfigured') return { kind: 'secret_misconfigured', detail: verification.howToFix };
    return { kind: 'bad_payload', detail: verification.howToFix };
  }
  // Catch the "relation does not exist" case the cloud throws when the
  // Phase 2 migration (0014_team_invites) hasn't been applied to the
  // deployment's Postgres yet. Surface a distinct failure card so
  // operators see "run migrations" rather than a generic 500.
  let row: Awaited<ReturnType<typeof getInviteByJti>>;
  try {
    row = await getInviteByJti(verification.payload.jti);
  } catch (err) {
    if (isMissingTeamInvitesTableError(err)) {
      return {
        kind: 'schema_not_migrated',
        detail:
          'The `team_invites` table is missing on the deployment Postgres. The admin must apply Drizzle migration 0014_team_invites (run `coodra db migrate` or `pnpm --filter @coodra/db exec drizzle-kit migrate --config=drizzle.postgres.config.ts`).',
      };
    }
    throw err;
  }
  if (row === null) return { kind: 'not_found' };
  if (row.revokedAt !== null) return { kind: 'revoked', revokedAt: row.revokedAt };
  if (row.usedAt !== null) return { kind: 'already_redeemed', usedAt: row.usedAt };
  return {
    kind: 'ok',
    email: verification.payload.email,
    role: verification.payload.role,
    expiresAt: new Date(verification.payload.exp * 1000).toISOString(),
    orgId: verification.payload.org,
  };
}

export default async function InstallPage({ params }: PageProps) {
  // Phase G — install flow works in any team mode (laptop or cloud).
  if (resolveIdentityMode() !== 'team') notFound();
  const { token } = await params;
  const preview = await buildPreview(token);

  return (
    <>
      <Topbar crumb="Accept invite" crumbPrefix="coodra / install" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/INSTALL · TEAMMATE ONBOARDING</div>
            <h1 className="head__title">
              {preview.kind === 'ok' ? (
                <>
                  You're <em>in</em>.
                </>
              ) : (
                <>
                  This invite <em>cannot</em> proceed.
                </>
              )}
            </h1>
            <p className="head__lede">
              {preview.kind === 'ok' ? (
                <>
                  Welcome to Coodra. Your Clerk identity is verified and your team membership is active. Pick
                  the path that matches how you'll use Coodra — both are reversible.
                </>
              ) : (
                <>{copyForFailure(preview)}</>
              )}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>single-use invite</strong>
              <br />
              {preview.kind === 'ok' ? `for ${preview.email}` : '—'}
              <br />
              {preview.kind === 'ok' ? `role · ${preview.role}` : ''}
            </div>
          </div>
        </div>

        {preview.kind === 'ok' ? (
          <OkLayout token={token} preview={preview} baseUrl={resolveDeploymentBaseUrl()} baseUrlUnset={isDeploymentBaseUrlUnset()} />
        ) : (
          <FailureLayout preview={preview} />
        )}
      </section>
    </>
  );
}

function copyForFailure(p: Exclude<Preview, { kind: 'ok' }>): string {
  switch (p.kind) {
    case 'expired':
      return 'This invite has expired. Ask the admin to mint a fresh one from /settings/team.';
    case 'revoked':
      return `This invite was revoked${p.revokedAt !== 'recently' ? ` on ${p.revokedAt}` : ''}. Ask the admin to mint a new one.`;
    case 'already_redeemed':
      return `This invite was already redeemed on ${p.usedAt}. Each invite is single-use; ask the admin for a fresh one if you need to set up another machine.`;
    case 'bad_signature':
      return 'The invite signature is invalid. Either the URL was tampered with or the deployment is running with a different invite secret than the one that minted this token.';
    case 'bad_payload':
      return `The invite payload failed validation: ${p.detail}`;
    case 'malformed':
      return 'The invite URL is malformed. Make sure you copied the entire link.';
    case 'secret_misconfigured':
      return p.detail;
    case 'not_found':
      return 'The invite record is missing from the deployment database. Ask the admin to mint a new one.';
    case 'schema_not_migrated':
      return p.detail;
  }
}

function OkLayout({
  token,
  preview,
  baseUrl,
  baseUrlUnset,
}: {
  readonly token: string;
  readonly preview: Extract<Preview, { kind: 'ok' }>;
  readonly baseUrl: string;
  readonly baseUrlUnset: boolean;
}) {
  const installCmd = `curl -sSL ${baseUrl}/install/${token}/cli.sh | sh`;
  const altCmd = `coodra team install --bootstrap-url ${baseUrl}/api/install/${token}`;
  return (
    <>
      {baseUrlUnset ? (
        <div
          style={{
            padding: '14px 18px',
            marginBottom: 18,
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--warn)',
            letterSpacing: '0.08em',
          }}
        >
          The install commands below contain a placeholder URL because{' '}
          <code>COODRA_PUBLIC_URL</code> is not set on this deployment. Ask the admin to set it to this
          deployment's external URL (e.g. <code>https://coodra.acme.com</code>) and redeploy before sharing
          this link.
        </div>
      ) : null}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginTop: 24 }}>
      <div className="card" style={{ padding: 36 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.18em', color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 8 }}>
          01
        </div>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Just <em>browse</em>
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 18 }}>
          If you're a PM, designer, or stakeholder who reads decisions and watches what the team is shipping —
          you're set. Open the dashboard, browse, sign out when you're done.
        </p>
        <p style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)', lineHeight: 1.7, marginBottom: 22 }}>
          This invite stays valid until you redeem it on a developer laptop. You can switch paths anytime.
        </p>
        <Link href="/" className="btn btn--accent">
          Open dashboard
        </Link>
      </div>

      <div className="card" style={{ padding: 36 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.18em', color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 8 }}>
          02
        </div>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Run AI agents on my <em>laptop</em>
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 18 }}>
          Installs the Coodra CLI, writes <code style={inlineMono}>~/.coodra/config.json</code>, and joins
          you to <span style={{ color: 'var(--ink)' }}>{preview.orgId.slice(0, 14)}…</span> as{' '}
          <span style={{ color: 'var(--ink)' }}>{preview.role}</span>. Runs in ~30 seconds.
        </p>

        <p style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)', lineHeight: 1.7, marginBottom: 8 }}>
          ONE-LINE INSTALL
        </p>
        <pre style={codeBlock}>{installCmd}</pre>

        <p style={{ marginTop: 18, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--ink-mute)', lineHeight: 1.7, marginBottom: 8 }}>
          OR — IF YOU ALREADY HAVE THE CLI
        </p>
        <pre style={codeBlock}>{altCmd}</pre>

        <p style={{ marginTop: 18, fontSize: 11, color: 'var(--caution)', fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
          Running either command consumes this invite. Re-running the URL afterward will 410.
        </p>
      </div>
    </div>
    </>
  );
}

function FailureLayout({ preview }: { readonly preview: Exclude<Preview, { kind: 'ok' }> }) {
  return (
    <div className="card" style={{ padding: 36, marginTop: 24, maxWidth: 720 }}>
      <h2 className="card__title" style={{ marginBottom: 14 }}>
        Next <em>steps</em>
      </h2>
      <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 18 }}>
        Reach out to whoever invited you and ask them to mint a fresh invite from{' '}
        <code style={inlineMono}>/settings/team</code>. If you don't know who that is, the contact is whoever
        deployed this Coodra instance.
      </p>
      <p style={{ fontSize: 11, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', lineHeight: 1.7 }}>
        Reason · <span style={{ color: 'var(--warn)' }}>{preview.kind}</span>
      </p>
    </div>
  );
}

const codeBlock: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '14px 18px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--ink)',
  letterSpacing: '0.04em',
  overflowX: 'auto',
  margin: 0,
};

const inlineMono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--accent)',
  background: 'var(--bg)',
  padding: '1px 6px',
  border: '1px solid var(--rule)',
};
