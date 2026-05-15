import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { joinExistingTeamAction } from '@/lib/actions/team-join';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { resolveEffectiveMode } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

/**
 * `/onboarding/team/join` — connect this machine to an *existing* team.
 *
 * The web flow that mirrors `coodra team join`. Used in three
 * scenarios:
 *
 *   1. Admin sets up the team on Machine A; later opens the web app
 *      on Machine B (new laptop, restored backup) and needs to bring
 *      that machine into the same team. They paste their credential
 *      bundle and the page writes ~/.coodra/config.json + .env.
 *
 *   2. New member receives the credential bundle from the admin via
 *      a secrets manager and uses this page (or the equivalent CLI
 *      command) to bootstrap their machine.
 *
 *   3. Anyone who lost their config but still has the bundle stored
 *      somewhere can recover by re-pasting.
 *
 * Distinct from /onboarding/team (which is /onboarding/team/create —
 * the wizard for the first admin who provisions Postgres + Clerk for
 * the very first time). That wizard MAKES the team. This page JOINS
 * an existing one.
 *
 * State is fully URL-driven (search params). The action redirects on
 * both success and error so the page is refresh-safe.
 */

interface SearchParams {
  readonly joinStatus?: string;
  readonly joinError?: string;
  readonly joinMessage?: string;
  readonly joinMissing?: string;
}

export default async function TeamJoinPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The page writes ~/.coodra/config.json + .env on the local
  // laptop. On a deployed server there's no ~/.coodra. Hide.
  if (resolveDeploymentMode() === 'team-hosted') notFound();
  const sp = await searchParams;
  const alreadyTeam = resolveEffectiveMode() === 'team';

  return (
    <>
      <Topbar crumb="Connect to existing team" crumbPrefix="coodra / onboarding" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · CONNECT TO EXISTING TEAM</div>
            <h1 className="head__title">
              Bring this machine <em>in</em>.
            </h1>
            <p className="head__lede">
              You have a team already — somewhere your admin set it up. Paste the credential bundle they shared and
              this machine joins. We never see your credentials; everything stays on your laptop and your cloud.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>~30 seconds</strong>
              <br />
              same flow for any role
              <br />
              admin / member / viewer
            </div>
            <div className="head__actions">
              <Link href="/welcome" className="btn btn--ghost">
                Back
              </Link>
            </div>
          </div>
        </div>

        {alreadyTeam ? (
          <Banner tone="ok">
            ● Team mode already active on this machine. Re-running this form is safe — it overwrites your local config
            with the credentials you paste. Useful for switching to a different team or re-keying after the admin
            rotated the hook secret.
          </Banner>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
          <form action={joinExistingTeamAction} className="card" style={{ padding: 36 }}>
            <h2 className="card__title" style={{ marginBottom: 14 }}>
              Paste your <em>credential bundle</em>
            </h2>
            <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 28 }}>
              Five pieces, all from your admin. Get them from a secrets manager (1Password / Bitwarden / Vault) — never
              copy-paste through unsecured channels.
            </p>

            <FieldLabel>1 · Database URL</FieldLabel>
            <input
              name="databaseUrl"
              type="password"
              autoComplete="off"
              style={fieldInputStyle}
              placeholder="postgresql://postgres.abc123:••••••@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
              required
            />
            <FieldHint>Your team's Supabase Session-pooler URL. Same one the admin set up with.</FieldHint>

            <FieldLabel style={{ marginTop: 22 }}>2 · Your Clerk user id</FieldLabel>
            <input
              name="userId"
              type="text"
              autoComplete="off"
              style={fieldInputStyle}
              placeholder="user_2nKjYourClerkUserId"
              pattern="user_[a-zA-Z0-9_-]+"
              required
            />
            <FieldHint>
              <strong>Your own</strong> Clerk user id, not the admin's. Sign into the team's Clerk app once to find it
              — usually shown on your Clerk profile page as <code style={inlineMono}>user_2nKj…</code>.
            </FieldHint>

            <FieldLabel style={{ marginTop: 22 }}>3 · The team's Clerk org id</FieldLabel>
            <input
              name="orgId"
              type="text"
              autoComplete="off"
              style={fieldInputStyle}
              placeholder="org_2nKjTheTeamsOrgId"
              pattern="org_[a-zA-Z0-9_-]+"
              required
            />
            <FieldHint>The Clerk org your admin created. Shared across all teammates.</FieldHint>

            <FieldLabel style={{ marginTop: 22 }}>4 · Org slug (optional)</FieldLabel>
            <input
              name="orgSlug"
              type="text"
              autoComplete="off"
              style={fieldInputStyle}
              placeholder="acme-team"
            />
            <FieldHint>Display label that shows up in your sidebar header. Cosmetic only — leave blank if unsure.</FieldHint>

            <FieldLabel style={{ marginTop: 22 }}>5 · Local hook secret</FieldLabel>
            <input
              name="secret"
              type="password"
              autoComplete="off"
              style={fieldInputStyle}
              placeholder="64-char hex"
              minLength={32}
              required
            />
            <FieldHint>
              The 32-byte hex string the admin generated at <code style={inlineMono}>coodra team setup</code> time.
              Same value as in their <code style={inlineMono}>~/.coodra/.env</code> under{' '}
              <code style={inlineMono}>LOCAL_HOOK_SECRET</code>. <strong>This is a sensitive secret.</strong>
            </FieldHint>

            <div style={{ marginTop: 28, display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn--accent">
                Validate + join team
              </button>
              <Link href="/welcome" className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>

          <SidePanel
            title={<>What this <em>does</em></>}
            rows={[
              { k: '1 · validates Postgres', v: 'SELECT 1 + counts the 12 Coodra tables. Catches typos before they corrupt your local config.' },
              { k: '2 · writes config.json', v: '~/.coodra/config.json::team — the file every coodra CLI command consults.' },
              { k: '3 · writes .env', v: '~/.coodra/.env — COODRA_MODE=team, DATABASE_URL, LOCAL_HOOK_SECRET, COODRA_TEAM_ORG_ID.' },
              { k: '4 · redirects', v: 'You land on the team-mode dashboard. Sidebar flips to green "● Team workspace".' },
              {
                k: 'note · Clerk keys',
                v: 'After this, manually append NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY to ~/.coodra/.env. The admin shares those too — they\'re the same for every teammate.',
              },
            ]}
          />
        </div>

        {sp.joinStatus === 'err' ? (
          <Banner tone="warn" style={{ marginTop: 28 }}>
            <strong style={{ marginRight: 8 }}>could not join</strong>
            {explainError(sp)}
          </Banner>
        ) : null}

        <div
          style={{
            marginTop: 56,
            padding: '24px 28px',
            border: '1px solid var(--rule)',
            background: 'var(--bg-2)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.22em',
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            Equivalent CLI command
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 14 }}>
            Same outcome from the terminal, useful when scripting or when the web app isn't running yet:
          </p>
          <pre
            style={{
              background: 'var(--bg)',
              border: '1px solid var(--rule)',
              padding: '16px 20px',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--ink)',
              letterSpacing: '0.04em',
              lineHeight: 1.7,
              overflowX: 'auto',
            }}
          >
{`coodra team join \\
  --user-id user_yours \\
  --org-id org_team \\
  --secret <64-char-hex> \\
  --database-url 'postgresql://...' \\
  --org-slug acme-team   # optional`}
          </pre>
        </div>
      </section>
    </>
  );
}

function explainError(sp: SearchParams): string {
  const err = sp.joinError;
  const msg = sp.joinMessage ?? '';
  if (err === 'empty_url') return 'Database URL is empty.';
  if (err === 'bad_protocol') return 'URL must start with postgres:// or postgresql://.';
  if (err === 'empty_user_id') return 'Your Clerk user id is required.';
  if (err === 'bad_user_id') return "Clerk user id should look like `user_2nKj...`.";
  if (err === 'empty_org_id') return "Team's Clerk org id is required.";
  if (err === 'bad_org_id') return "Clerk org id should look like `org_2nKj...`.";
  if (err === 'bad_secret') return 'Hook secret must be at least 32 characters (the admin generated 64-char hex).';
  if (err === 'cannot_construct') return `Cannot construct Postgres client — ${msg}.`;
  if (err === 'select_one_failed')
    return `Connection failed: ${msg}. Verify the URL is exactly what your admin shared.`;
  if (err === 'schema_probe_failed') return `Connected, but schema query failed — ${msg}.`;
  if (err === 'schema_missing')
    return `Connected, but ${sp.joinMissing ?? 'some'} required Coodra tables are missing. This usually means the admin hasn't run \`coodra team setup\` against this Postgres yet, or you pasted the wrong DATABASE_URL.`;
  if (err === 'write_failed') return `Could not write local config: ${msg}.`;
  return msg.length > 0 ? msg : 'Unknown error.';
}

function SidePanel({ title, rows }: { readonly title: React.ReactNode; readonly rows: ReadonlyArray<{ k: string; v: string }> }) {
  return (
    <div className="aside-card">
      <h3 className="aside-card__title" style={{ marginBottom: 16 }}>
        {title}
      </h3>
      {rows.map((r, i) => (
        <div
          key={r.k}
          style={{
            padding: '12px 0',
            borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--rule)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.2em',
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            {r.k}
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.55 }}>{r.v}</div>
        </div>
      ))}
    </div>
  );
}

function FieldLabel({ children, style }: { readonly children: React.ReactNode; readonly style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 9,
        letterSpacing: '0.2em',
        color: 'var(--ink-mute)',
        textTransform: 'uppercase',
        marginBottom: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function FieldHint({ children }: { readonly children: React.ReactNode }) {
  return (
    <p
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        color: 'var(--ink-mute)',
        marginTop: 6,
        letterSpacing: '0.04em',
        lineHeight: 1.7,
      }}
    >
      {children}
    </p>
  );
}

function Banner({ children, tone, style }: { readonly children: React.ReactNode; readonly tone: 'ok' | 'warn'; readonly style?: React.CSSProperties }) {
  return (
    <div
      style={{
        padding: '14px 18px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.06em',
        lineHeight: 1.7,
        ...style,
      }}
    >
      {children}
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

const fieldInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
};
