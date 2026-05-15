import Link from 'next/link';

import { clerkAppearance } from '@/lib/clerk-appearance';
import { resolveDeploymentMode } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

/**
 * `/forbidden` — landing page when the team-hosted org-match invariant
 * rejects a request. Two distinct cases:
 *
 *   reason=no_org        — user is signed into Clerk but has no active
 *                          organization context. Two sub-cases:
 *                            a) They're the very first admin and need
 *                               to CREATE their team's org.
 *                            b) They're a stranger / not yet invited.
 *                          We surface Clerk's <CreateOrganization />
 *                          widget so (a) can self-serve without
 *                          leaving the app.
 *
 *   reason=org_mismatch  — user is in some org, but not the org this
 *                          deployment is pinned to (COODRA_EXPECTED_ORG_ID).
 *                          We show the diagnostic + link them to switch
 *                          orgs in Clerk.
 *
 *   reason=insufficient_role — user is in the right org but their
 *                              role is below what the action needed.
 *                              Server-action redirect.
 *
 *   reason=local_only    — they hit an action that only works on a
 *                          developer's laptop (e.g., coodra init),
 *                          but the deployment is team-hosted.
 */

interface SearchParams {
  readonly reason?: string;
  readonly expected?: string;
  readonly got?: string;
  readonly action?: string;
  readonly needed?: string;
  readonly actor_role?: string;
}

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const reason = sp.reason ?? 'unknown';
  const isTeamHosted = resolveDeploymentMode() === 'team-hosted';

  return (
    <section className="screen" style={{ maxWidth: 920 }}>
      <div className="head">
        <div>
          <div className="head__num" style={{ color: 'var(--warn)' }}>
            /403 · {reasonLabel(reason)}
          </div>
          <h1 className="head__title">{reasonTitle(reason)}</h1>
          <p className="head__lede">{reasonLede(reason, sp)}</p>
        </div>
      </div>

      {reason === 'no_org' && isTeamHosted ? <NoOrgBootstrap /> : null}

      {(reason === 'org_mismatch' || reason === 'insufficient_role') && (sp.expected !== undefined || sp.needed !== undefined) ? (
        <Diagnostic sp={sp} />
      ) : null}

      <div style={{ display: 'flex', gap: 10, marginTop: 36 }}>
        {isTeamHosted ? (
          <Link href="/auth/sign-in" className="btn">
            Sign in as a different user
          </Link>
        ) : (
          <Link href="/" className="btn">
            Back to dashboard
          </Link>
        )}
        <a href="https://dashboard.clerk.com" target="_blank" rel="noreferrer" className="btn btn--ghost">
          Open Clerk dashboard
        </a>
      </div>
    </section>
  );
}

function reasonLabel(reason: string): string {
  if (reason === 'no_org') return 'NO ORG ON SESSION';
  if (reason === 'org_mismatch') return 'WRONG ORG';
  if (reason === 'insufficient_role') return 'INSUFFICIENT ROLE';
  if (reason === 'local_only') return 'LOCAL-ONLY ACTION';
  return 'FORBIDDEN';
}

function reasonTitle(reason: string): React.ReactNode {
  if (reason === 'no_org')
    return (
      <>
        Create your <em>team's org</em>.
      </>
    );
  if (reason === 'org_mismatch')
    return (
      <>
        Not <em>your</em> workspace.
      </>
    );
  if (reason === 'insufficient_role')
    return (
      <>
        Your role can't <em>do that</em>.
      </>
    );
  if (reason === 'local_only')
    return (
      <>
        That's a <em>local</em> action.
      </>
    );
  return <>Access denied.</>;
}

function reasonLede(reason: string, sp: SearchParams): string {
  if (reason === 'no_org')
    return "You're signed into Clerk successfully — but your account isn't in any organization yet. If you're the team's admin setting up for the first time, create your org below. If you're a teammate who expected to already be in one, ask your admin for an invite.";
  if (reason === 'org_mismatch')
    return 'You signed in successfully, but your active Clerk organization isn’t the one this deployment serves. Switch your active org in Clerk and reload, or ask your admin for an invite to the right org.';
  if (reason === 'insufficient_role')
    return `That action requires the '${sp.needed ?? '?'}' role. Your current role is '${sp.actor_role ?? '?'}'. Ask the team admin to elevate your Clerk org role.`;
  if (reason === 'local_only')
    return `${sp.action ?? 'That action'} only runs on a developer's laptop — it writes to ~/.coodra/ or spawns local daemons that the deployment server doesn't have. Use the CLI from your own machine instead.`;
  return 'Access denied. This usually means your Clerk account isn’t a member of the right organization for this deployment.';
}

async function NoOrgBootstrap() {
  // Render Clerk's CreateOrganization widget so the first admin can
  // mint their team's org without leaving the app. After creation,
  // Clerk auto-makes them an admin of the new org and updates their
  // session.orgId — they reload the page and the middleware lets
  // them through (assuming COODRA_EXPECTED_ORG_ID matches the new
  // org id; if the admin pinned a different EXPECTED_ORG_ID they'll
  // need to update the deployment env after creation).
  const { CreateOrganization } = await import('@clerk/nextjs');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 28 }}>
      <div
        style={{
          padding: '14px 18px',
          border: '1px solid var(--accent)',
          background: 'var(--accent-glow)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            marginBottom: 6,
          }}
        >
          First-admin bootstrap
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.6 }}>
          Use the widget below to create your team's organization. Clerk will name you admin
          automatically. After creation, copy the resulting <code style={inlineMono}>org_…</code> id
          and set <code style={inlineMono}>COODRA_EXPECTED_ORG_ID</code> in this deployment's env
          (Vercel project settings, fly secrets, docker -e, etc.), then redeploy. Until that
          variable is set to your new org id, the middleware will keep bouncing every signed-in
          user to this page.
        </p>
      </div>
      <CreateOrganization
        appearance={clerkAppearance}
        routing="path"
        path="/forbidden"
        afterCreateOrganizationUrl="/"
      />
    </div>
  );
}

function Diagnostic({ sp }: { readonly sp: SearchParams }) {
  return (
    <div
      style={{
        padding: '20px 24px',
        border: '1px solid var(--rule)',
        background: 'var(--bg-2)',
        marginBottom: 28,
        marginTop: 28,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 12,
        }}
      >
        Diagnostic
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink)',
          letterSpacing: '0.04em',
          lineHeight: 1.7,
        }}
      >
        {sp.expected !== undefined ? (
          <div>
            <span style={{ color: 'var(--ink-mute)' }}>this deployment serves:</span>{' '}
            <span style={{ color: 'var(--accent)' }}>{sp.expected}</span>
          </div>
        ) : null}
        {sp.got !== undefined ? (
          <div style={{ marginTop: 6 }}>
            <span style={{ color: 'var(--ink-mute)' }}>your current org:</span>{' '}
            <span style={{ color: 'var(--warn)' }}>{sp.got}</span>
          </div>
        ) : null}
        {sp.needed !== undefined ? (
          <div style={{ marginTop: 6 }}>
            <span style={{ color: 'var(--ink-mute)' }}>required role:</span>{' '}
            <span style={{ color: 'var(--accent)' }}>{sp.needed}</span>
          </div>
        ) : null}
        {sp.actor_role !== undefined ? (
          <div style={{ marginTop: 6 }}>
            <span style={{ color: 'var(--ink-mute)' }}>your role:</span>{' '}
            <span style={{ color: 'var(--warn)' }}>{sp.actor_role}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const inlineMono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  color: 'var(--accent)',
  background: 'var(--bg)',
  padding: '1px 6px',
  border: '1px solid var(--rule)',
};
