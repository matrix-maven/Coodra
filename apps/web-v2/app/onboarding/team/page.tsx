import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { verifyCloudConnectionAction } from '@/lib/actions/onboarding';
import { runTeamInitWizardAction } from '@/lib/actions/team-init';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { resolveEffectiveMode } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

/**
 * `/onboarding/team` — the team-mode onboarding wizard.
 *
 * Five linear steps. The wizard never makes a destructive change — it
 * only verifies + explains + hands the user the exact CLI command to
 * run. Persistence happens through `coodra team setup`, which
 * writes `~/.coodra/config.json::team` + `~/.coodra/.env` (the
 * env file is the one `coodra start` reads when spawning daemons).
 *
 *   Step 1 · Supabase  — admin creates a Postgres project, copies URL.
 *   Step 2 · Connect   — admin pastes the URL; we verify reachability + schema.
 *   Step 3 · Clerk     — admin creates a Clerk app + an org, copies keys + their userId / orgId.
 *   Step 4 · CLI       — admin runs `coodra team setup` (we render the exact, copy-paste-ready command).
 *   Step 5 · Invite    — admin shares the four-credential block with teammates so they can run `coodra team join`.
 *
 * State is fully URL-driven (search params). No client state. The
 * verify-step server action redirects with the result encoded back
 * into params. This makes the wizard refresh-safe, deep-linkable, and
 * resumeable from any step (admins are likely to do this in pieces).
 */

interface ExecResultParams {
  readonly execStatus?: string;
  readonly execStep?: string;
  readonly execError?: string;
  readonly execHowToFix?: string;
  readonly execMode?: string;
}

interface SearchParams extends ExecResultParams {
  readonly step?: string;
  readonly verifyStatus?: string;
  readonly verifyError?: string;
  readonly verifyMessage?: string;
  readonly verifyMissing?: string;
  readonly verifyTables?: string;
  readonly verifyElapsedMs?: string;
}

export default async function TeamOnboardingWizardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The wizard guides an admin through running `coodra team setup`
  // on their LAPTOP — the resulting writes go to ~/.coodra/ which
  // doesn't exist on a deployed server. Hide on team-hosted so the
  // sidebar's "Set up team / Mode picker" never opens this page from
  // a hosted dashboard.
  if (resolveDeploymentMode() === 'team-hosted') notFound();
  const sp = await searchParams;
  const stepRaw = parseInt(sp.step ?? '1', 10);
  const step = Number.isFinite(stepRaw) && stepRaw >= 1 && stepRaw <= 5 ? stepRaw : 1;

  const alreadyTeam = resolveEffectiveMode() === 'team';

  return (
    <>
      <Topbar crumb="Team setup" crumbPrefix="coodra / onboarding" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · TEAM ONBOARDING</div>
            <h1 className="head__title">
              Stand up your <em>team</em>.
            </h1>
            <p className="head__lede">
              Five steps. You bring a Supabase project + a Clerk org. We never see those credentials — they live on
              your machine and your cloud accounts. The CLI does every persistent write.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>~5 min</strong>
              <br />
              admin only
              <br />
              run once per team
            </div>
            <div className="head__actions">
              <Link href="/welcome" className="btn btn--ghost">
                Back to mode picker
              </Link>
            </div>
          </div>
        </div>

        {alreadyTeam ? (
          <Banner tone="ok">
            ● Team mode is already configured on this machine. Re-running these steps is safe (idempotent) — useful for
            rotating the hook secret or moving to a new Postgres host.
          </Banner>
        ) : null}

        <Stepper current={step} />

        {step === 1 ? <StepOneSupabase /> : null}
        {step === 2 ? <StepTwoConnect sp={sp} /> : null}
        {step === 3 ? <StepThreeClerk sp={sp} /> : null}
        {step === 4 ? <StepFourCli sp={sp} /> : null}
        {step === 5 ? <StepFiveInvite /> : null}
      </section>
    </>
  );
}

/* ---------- stepper ---------- */

const STEPS: ReadonlyArray<{ readonly num: string; readonly label: string }> = [
  { num: '01', label: 'Supabase' },
  { num: '02', label: 'Connect + verify' },
  { num: '03', label: 'Clerk' },
  { num: '04', label: 'Run CLI' },
  { num: '05', label: 'Invite team' },
];

function Stepper({ current }: { readonly current: number }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${STEPS.length}, 1fr)`,
        gap: 0,
        borderTop: '1px solid var(--rule)',
        borderBottom: '1px solid var(--rule)',
        marginBottom: 56,
      }}
    >
      {STEPS.map((s, i) => {
        const idx = i + 1;
        const isActive = idx === current;
        const isDone = idx < current;
        return (
          <Link
            key={s.num}
            href={`/onboarding/team?step=${idx}`}
            style={{
              padding: '24px 24px',
              borderRight: i === STEPS.length - 1 ? 'none' : '1px solid var(--rule)',
              textDecoration: 'none',
              display: 'block',
              background: isActive ? 'var(--accent-glow)' : 'transparent',
              transition: 'background .2s',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.2em',
                color: isActive || isDone ? 'var(--accent)' : 'var(--ink-mute)',
                textTransform: 'uppercase',
                marginBottom: 10,
              }}
            >
              {isDone ? '✓ ' : ''}
              {s.num}
            </div>
            <div
              style={{
                fontFamily: 'var(--serif)',
                fontSize: 22,
                fontWeight: 400,
                letterSpacing: '-0.01em',
                color: isActive ? 'var(--ink)' : isDone ? 'var(--ink)' : 'var(--ink-dim)',
              }}
            >
              {s.label}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/* ---------- step 1 ---------- */

function StepOneSupabase() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
      <div className="card" style={{ padding: 36 }}>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Create a <em>Postgres</em> project.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 28 }}>
          Coodra team mode needs a Postgres ≥ 16 with the <code style={inlineMono}>pgvector</code> extension. Supabase
          is the easy default — free tier is fine for a small team. The free tier’s pooler is sufficient for the workload
          Coodra produces (small append-only inserts).
        </p>

        <Substep
          n="1.1"
          title={<>Create a project at supabase.com</>}
          body={
            <>
              <span>
                Visit{' '}
                <a href="https://supabase.com/dashboard/new" target="_blank" rel="noreferrer" style={linkStyle}>
                  supabase.com/dashboard/new
                </a>
                . Pick any region near you. Set a strong DB password — you’ll need it in step 1.2.
              </span>
            </>
          }
        />

        <Substep
          n="1.2"
          title={<>Copy the connection string</>}
          body={
            <>
              <span>
                In the project, open <strong>Project Settings → Database → Connection string</strong>. Pick the{' '}
                <strong>Session pooler</strong> (port 5432). Replace <code style={inlineMono}>[YOUR-PASSWORD]</code> with
                the password you set. The string looks like:
              </span>
              <pre style={codeBlockStyle}>
                postgresql://postgres.abc123:YOUR-PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
              </pre>
              <span style={{ display: 'block', marginTop: 10, color: 'var(--caution)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                Avoid the “Transaction pooler” (port 6543) — its prepared-statement semantics break Drizzle migrations.
              </span>
            </>
          }
        />

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <Link href="/onboarding/team?step=2" className="btn btn--accent">
            I have my connection string
          </Link>
          <a href="https://supabase.com/dashboard/new" target="_blank" rel="noreferrer" className="btn btn--ghost">
            Open Supabase
          </a>
        </div>
      </div>

      <SidePanel
        title={<>Why <em>Postgres</em>?</>}
        rows={[
          { k: 'Append-only audit', v: 'Decisions, runs, packs flow into the cloud DB so teammates can read each other’s history.' },
          { k: 'pgvector', v: 'Used by Module 05’s semantic search over context packs.' },
          { k: 'You own the data', v: 'Coodra never sees these credentials. The DB lives in your Supabase account.' },
          { k: 'Cost', v: 'Free tier handles ~50 active users for an active team. Upgrade only if you scale.' },
        ]}
      />
    </div>
  );
}

/* ---------- step 2 ---------- */

function StepTwoConnect({ sp }: { readonly sp: SearchParams }) {
  const verifyStatus = sp.verifyStatus;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
      <div className="card" style={{ padding: 36 }}>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Connect + <em>verify</em>.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 28 }}>
          Paste the URL from step 1.2. We run <code style={inlineMono}>SELECT 1</code> + a schema-presence probe. We
          never store the URL — that’s the CLI’s job (step 4).
        </p>

        <form action={verifyCloudConnectionAction}>
          <FieldLabel>Database URL</FieldLabel>
          <input
            name="databaseUrl"
            type="password"
            autoComplete="off"
            style={fieldInputStyle}
            placeholder="postgresql://postgres.abc123:••••••@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
            required
          />
          <FieldHint>
            Copied from <strong>Project Settings → Database → Connection string</strong> → Session pooler.
          </FieldHint>

          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <button type="submit" className="btn btn--accent">
              Verify connection
            </button>
            <Link href="/onboarding/team?step=1" className="btn btn--ghost">
              Back
            </Link>
          </div>
        </form>

        {verifyStatus === 'err' ? (
          <Banner tone="warn" style={{ marginTop: 24 }}>
            <strong style={{ marginRight: 8 }}>verification failed</strong>
            {explainError(sp)}
          </Banner>
        ) : null}
      </div>

      <SidePanel
        title={<>What we <em>check</em></>}
        rows={[
          { k: '1 · reachability', v: 'SELECT 1 against the URL. Catches typos, wrong password, blocked egress.' },
          { k: '2 · schema', v: 'List public tables. Expects 12 Coodra tables.' },
          { k: 'first run', v: 'Schema is missing — that’s expected. Step 4 (CLI) applies migrations to the same DB.' },
          { k: 'we never store', v: 'The URL travels through the page POST → the verify action → trash. The CLI is what writes credentials.' },
        ]}
      />
    </div>
  );
}

function explainError(sp: SearchParams): string {
  const err = sp.verifyError;
  const msg = sp.verifyMessage ?? '';
  if (err === 'empty_url') return 'Database URL is empty. Paste the string from Supabase.';
  if (err === 'bad_protocol') return 'URL must start with postgres:// or postgresql://.';
  if (err === 'cannot_construct') return `Cannot construct Postgres client — ${msg}. Check URL syntax.`;
  if (err === 'select_one_failed')
    return `Connection failed: ${msg}. Verify password is correct and the project is unpaused.`;
  if (err === 'schema_probe_failed')
    return `Connected, but schema query threw: ${msg}. Use the postgres role from the connection-string panel.`;
  if (err === 'schema_missing')
    return `Connection works — but schema isn’t applied yet. That’s fine on a fresh project. Step 4 runs the CLI which applies migrations. Missing tables: ${sp.verifyMissing ?? '?'}.`;
  return msg.length > 0 ? msg : 'unknown error';
}

/* ---------- step 3 ---------- */

function StepThreeClerk({ sp }: { readonly sp: SearchParams }) {
  const wasVerified = sp.verifyStatus === 'ok';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
      <div className="card" style={{ padding: 36 }}>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Set up <em>Clerk</em>.
        </h2>
        {wasVerified ? (
          <div
            style={{
              padding: '10px 14px',
              border: '1px solid var(--accent)',
              background: 'var(--accent-glow)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: '0.06em',
              color: 'var(--accent)',
              marginBottom: 24,
            }}
          >
            ✓ Postgres reachable · {sp.verifyTables ?? '12'} tables present · {sp.verifyElapsedMs ?? '?'} ms
          </div>
        ) : null}
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 20 }}>
          Clerk is your team’s identity provider. Each member signs into the web app via Clerk. Your <strong>org</strong>{' '}
          inside Clerk is what scopes Coodra data — every decision/pack/run is stamped with the author’s Clerk user
          id, then filtered through the org id when teammates read.
        </p>

        <div
          style={{
            padding: '14px 18px',
            marginBottom: 28,
            border: '1px solid var(--caution)',
            background: 'rgba(192, 138, 62, 0.08)',
            fontSize: 13,
            color: 'var(--ink)',
            lineHeight: 1.65,
          }}
        >
          <strong style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em', color: 'var(--caution)' }}>
            ⚠ ORDER MATTERS
          </strong>
          <br />
          You can't run <code style={inlineMono}>coodra team setup --user-id ... --org-id ...</code> with values
          that don't yet exist in Clerk. You'd end up with a working <em>local-team</em> setup that nobody else can
          ever sign into, because Clerk would never produce sessions matching those fake IDs. Complete substeps 3.1
          through 3.4 below <em>first</em>, then return to Step 5 with the real ids in hand.
        </div>

        <Substep
          n="3.1"
          title={<>Create a Clerk application</>}
          body={
            <>
              <span>
                Visit{' '}
                <a href="https://dashboard.clerk.com/apps/new" target="_blank" rel="noreferrer" style={linkStyle}>
                  dashboard.clerk.com/apps/new
                </a>
                . Pick name “Coodra”. Enable <strong>Email + Password</strong> at minimum; OAuth is optional.
              </span>
            </>
          }
        />

        <Substep
          n="3.2"
          title={<>Enable Organizations</>}
          body={
            <>
              <span>
                In your Clerk app, open <strong>Organizations → Settings</strong> and toggle “Enable organizations”.
                Optionally add the <strong>org:viewer</strong> custom role for read-only seats (members and admins exist
                by default).
              </span>
            </>
          }
        />

        <Substep
          n="3.3"
          title={<>Sign yourself up + create your team's org</>}
          body={
            <>
              <span>
                Two things, in order:
              </span>
              <ol style={{ paddingLeft: 20, marginTop: 8, lineHeight: 1.7 }}>
                <li>
                  Open your Clerk app's sign-in page (the Clerk dashboard will give you a URL like{' '}
                  <code style={inlineMono}>https://&lt;slug&gt;.clerk.accounts.dev</code>) and sign up. This mints
                  your real <code style={inlineMono}>user_2nKj…</code> id — the FIRST one in your org. Copy it from
                  the Clerk dashboard's <strong>Users</strong> tab once you're signed up.
                </li>
                <li>
                  In Clerk's UI, create a new organization for your team. You'll automatically be its admin. Copy
                  the resulting <code style={inlineMono}>org_2nKj…</code> id from the <strong>Organizations</strong>{' '}
                  tab.
                </li>
              </ol>
              <span style={{ marginTop: 10, display: 'block', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--caution)' }}>
                Both ids are needed in Step 5. The user_id is yours; the org_id is the team's. They're stable text
                strings — Clerk hands them out and never recycles them.
              </span>
            </>
          }
        />

        <Substep
          n="3.4"
          title={<>Copy the publishable + secret keys</>}
          body={
            <>
              <span>
                In Clerk’s <strong>API Keys</strong> page, copy <code style={inlineMono}>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>{' '}
                and <code style={inlineMono}>CLERK_SECRET_KEY</code>. The web app reads both — the publishable on the client,
                the secret on the server. They go into <code style={inlineMono}>~/.coodra/.env</code> in step 4.
              </span>
            </>
          }
        />

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <Link href="/onboarding/team?step=4" className="btn btn--accent">
            Got my Clerk keys
          </Link>
          <Link href="/onboarding/team?step=2" className="btn btn--ghost">
            Back
          </Link>
        </div>
      </div>

      <SidePanel
        title={<>Why <em>Clerk</em>?</>}
        rows={[
          { k: 'Identity', v: 'Stable user_id + org_id every server action can rely on. Coodra RBAC reads from these.' },
          { k: 'Three roles', v: 'admin / member / viewer. Default Clerk roles + one custom (viewer). No custom auth code.' },
          { k: 'Free tier', v: 'Up to 10,000 monthly active users. More than enough for an org.' },
          { k: 'Replaceable', v: 'If you don’t want Clerk, you can run only the local bridge — but the web app team UI needs Clerk.' },
        ]}
      />
    </div>
  );
}

/* ---------- step 4 ---------- */

function StepFourCli({ sp }: { readonly sp: SearchParams }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
      <div className="card" style={{ padding: 36 }}>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Run <em>coodra team init</em>.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 18 }}>
          One interactive command persists everything. The wizard prompts you for your DATABASE_URL and Clerk Secret
          Key, looks up your user_id + org_id from Clerk automatically, then writes the local config and starts the
          team-mode env. No flags needed for first-time setup — just paste the two values when asked.
        </p>
        <p style={{ fontSize: 13, color: 'var(--ink-mute)', lineHeight: 1.6, marginBottom: 28 }}>
          (Phase B, 2026-05-11): the legacy six-flag <code style={inlineMono}>coodra team setup</code> still works
          for CI / automation — see <code style={inlineMono}>coodra team setup --help</code>. Most users should
          prefer the interactive <code style={inlineMono}>team init</code> wizard.
        </p>

        <FieldLabel>Run this in your terminal</FieldLabel>
        <pre style={{ ...codeBlockStyle, padding: 22 }}>
{`coodra team init`}
        </pre>
        <details style={{ marginTop: 14, fontSize: 12, color: 'var(--ink-dim)' }}>
          <summary style={{ cursor: 'pointer' }}>Need a non-interactive command for CI?</summary>
          <pre style={{ ...codeBlockStyle, padding: 18, marginTop: 12 }}>
{`coodra team setup \\
  --database-url 'postgresql://postgres.abc123:YOUR-PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres' \\
  --user-id 'user_2nKjYourClerkUserId' \\
  --org-id 'org_2nKjYourClerkOrgId'`}
          </pre>
        </details>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            marginTop: 24,
          }}
        >
          <ParamCard label="--database-url" source="Step 1.2" desc="The Supabase Session-pooler URL with your password." />
          <ParamCard label="--user-id" source="Step 3.3" desc="Your own Clerk user id from your org membership." />
          <ParamCard label="--org-id" source="Step 3.3" desc="The Clerk org id you created." />
          <ParamCard label="--secret (optional)" source="auto-generated" desc="Skip — we generate a random 32-byte secret." />
        </div>

        <p style={{ marginTop: 24, fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
          You also need the Clerk keys in <code style={inlineMono}>~/.coodra/.env</code>. Copy this block manually
          after the CLI runs — three lines, the publishable key appears twice (one for the web app’s React tree, one
          for the daemons’ Zod-validated env):
        </p>
        <pre style={{ ...codeBlockStyle, padding: 22 }}>
{`# append to ~/.coodra/.env
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_…
CLERK_PUBLISHABLE_KEY=pk_live_…
CLERK_SECRET_KEY=sk_live_…`}
        </pre>
        <p
          style={{
            marginTop: 20,
            padding: '14px 18px',
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
            fontSize: 13,
            color: 'var(--ink)',
            lineHeight: 1.65,
          }}
        >
          <strong style={{ color: 'var(--warn)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em' }}>
            ⚠ DEPLOYING THE WEB ANYWHERE (Vercel/Fly/Docker)?
          </strong>
          <br />
          You MUST set <code style={inlineMono}>COODRA_EXPECTED_ORG_ID=org_…</code> + {' '}
          <code style={inlineMono}>COODRA_DEPLOYMENT=team-hosted</code> in your deployment env. Without the
          expected-org pin, anyone with a Clerk account in your Clerk app (including random Google sign-ups) can
          sign in and read your team's data. The web app refuses to boot in team-hosted mode without it.
        </p>
        <p
          style={{
            marginTop: 8,
            fontSize: 11,
            fontFamily: 'var(--mono)',
            color: 'var(--caution)',
            letterSpacing: '0.04em',
            lineHeight: 1.7,
          }}
        >
          The <code style={inlineMono}>NEXT_PUBLIC_</code> prefix exposes the key to the browser bundle; the
          unprefixed copy is what the MCP server + Hooks Bridge boot-time env validators look for. Skipping the
          unprefixed line crashes <code style={inlineMono}>coodra start</code> with{' '}
          <code style={inlineMono}>CLERK_PUBLISHABLE_KEY required when CLERK_SECRET_KEY is set</code>.
        </p>

        <ExecuteInBrowserForm sp={sp} />

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <Link href="/onboarding/team?step=5" className="btn btn--accent">
            CLI ran successfully
          </Link>
          <Link href="/onboarding/team?step=3" className="btn btn--ghost">
            Back
          </Link>
        </div>
      </div>

      <SidePanel
        title={<>What it <em>writes</em></>}
        rows={[
          { k: 'config.json', v: '~/.coodra/config.json::team — clerkUserId, clerkOrgId, localHookSecret, joinedAt.' },
          { k: '.env', v: '~/.coodra/.env — COODRA_MODE=team, DATABASE_URL, LOCAL_HOOK_SECRET, COODRA_TEAM_ORG_ID.' },
          { k: 'cloud schema', v: '13 Drizzle migrations applied to your Postgres.' },
          { k: 'pgvector', v: 'CREATE EXTENSION IF NOT EXISTS vector. Idempotent.' },
          { k: 're-runs', v: 'Safe — repeat to rotate the hook secret or migrate to a new DB.' },
        ]}
      />
    </div>
  );
}

/* ---------- step 5 ---------- */

function StepFiveInvite() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
      <div className="card" style={{ padding: 36 }}>
        <h2 className="card__title" style={{ marginBottom: 14 }}>
          Invite your <em>team</em>.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 28 }}>
          Each teammate runs one command after they install the CLI. They need four things from you. Distribute them via
          a secrets manager (1Password / Bitwarden / Vault) — anyone with the URL + secret can write to your team
          Postgres.
        </p>

        <FieldLabel>What to share with each teammate</FieldLabel>
        <pre style={{ ...codeBlockStyle, padding: 22 }}>
{`database url        postgresql://postgres.abc…@…:5432/postgres
clerk org id        org_2nKjYourClerkOrgId
local hook secret   <printed by step 4 — don't lose it>
clerk publishable   pk_live_…   (each teammate appends as BOTH
                                 NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
                                 and CLERK_PUBLISHABLE_KEY= to ~/.coodra/.env)
clerk secret key    sk_live_…   (each teammate appends as
                                 CLERK_SECRET_KEY= to ~/.coodra/.env)`}
        </pre>

        <FieldLabel style={{ marginTop: 24 }}>Each teammate runs</FieldLabel>
        <pre style={{ ...codeBlockStyle, padding: 22 }}>
{`coodra team join \\
  --user-id <their-clerk-user-id> \\
  --org-id 'org_2nKjYourClerkOrgId' \\
  --secret '<the-hook-secret-from-step-4>' \\
  --database-url 'postgresql://…'`}
        </pre>

        <p style={{ marginTop: 24, fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
          They also append the same Clerk publishable + secret keys to their own{' '}
          <code style={inlineMono}>~/.coodra/.env</code>. Once they run <code style={inlineMono}>coodra start</code>,
          their bridge syncs to the same Postgres — and from then on, all your runs / decisions / packs flow into one
          shared audit history.
        </p>

        <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
          <Link href="/" className="btn btn--accent">
            Open dashboard
          </Link>
          <Link href="/settings/team" className="btn">
            Team settings
          </Link>
          <Link href="/onboarding/team?step=4" className="btn btn--ghost">
            Back
          </Link>
        </div>
      </div>

      <SidePanel
        title={<>What teammates <em>get</em></>}
        rows={[
          { k: 'Recent decisions', v: 'They see your last 7 days of decisions injected at every SessionStart.' },
          { k: 'Cross-team packs', v: 'search_packs_nl reads context packs from every org member.' },
          { k: 'Author attribution', v: 'Every row carries who wrote it. The web app shows “decided by Alice” badges.' },
          { k: 'Local-first', v: 'Their local SQLite stays primary. Sync daemon mirrors to your Postgres async.' },
        ]}
      />
    </div>
  );
}

/* ---------- shared atoms ---------- */

function Substep({ n, title, body }: { readonly n: string; readonly title: React.ReactNode; readonly body: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '20px 0',
        borderTop: '1px solid var(--rule)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 8 }}>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.18em',
            color: 'var(--accent)',
            textTransform: 'uppercase',
            minWidth: 36,
          }}
        >
          {n}
        </span>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400, letterSpacing: '-0.005em' }}>
          {title}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, paddingLeft: 50 }}>{body}</div>
    </div>
  );
}

function ParamCard({ label, source, desc }: { readonly label: string; readonly source: string; readonly desc: string }) {
  return (
    <div style={{ padding: 16, border: '1px solid var(--rule)', background: 'var(--bg)' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--accent)',
          letterSpacing: '0.04em',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.18em',
          color: 'var(--ink-mute)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        from {source}
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
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
        lineHeight: 1.6,
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

const linkStyle: React.CSSProperties = {
  color: 'var(--accent)',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
};

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

const codeBlockStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '18px 22px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.7,
  color: 'var(--ink)',
  whiteSpace: 'pre',
  overflowX: 'auto',
  marginTop: 12,
};

/**
 * Phase B (clarity-pass-plan, 2026-05-11) — alternate path to the CLI
 * `team init` wizard. Some admins prefer pasting credentials into a
 * browser form over a terminal prompt. The form posts to
 * `runTeamInitWizardAction` which runs the same shared library
 * functions the CLI does, writes the same `~/.coodra/` files,
 * then redirects to `/settings/team`.
 *
 * Refused in `team-hosted` (the deployment server doesn't have a
 * `~/.coodra/`) and `local-team` (already set up). The action
 * double-checks this gate; the form is hidden on the page when the
 * top-level mode check already redirected.
 */
function ExecuteInBrowserForm({ sp }: { readonly sp: SearchParams }) {
  const failed = sp.execStatus === 'err';
  const refused = sp.execStatus === 'refused';
  const failedStep = sp.execStep ?? '';
  const failedCode = sp.execError ?? '';
  const failedHowToFix = sp.execHowToFix ?? '';
  return (
    <details
      open={failed || refused}
      style={{
        marginTop: 26,
        padding: '14px 18px',
        border: '1px solid var(--rule)',
        background: 'var(--bg-2)',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
        }}
      >
        Or: execute in browser (alternate path)
      </summary>
      <p style={{ fontSize: 12, color: 'var(--ink-dim)', lineHeight: 1.65, marginTop: 14, marginBottom: 14 }}>
        Paste your DATABASE_URL and Clerk Secret Key below. The form runs the same three-step bootstrap the CLI does
        and writes to <code style={inlineMono}>~/.coodra/</code> on this machine. Refused in team-hosted
        deployments — the wizard only ships writes to the laptop running this dev server.
      </p>
      {failed ? (
        <div
          style={{
            marginBottom: 14,
            padding: '12px 16px',
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            lineHeight: 1.7,
            color: 'var(--ink)',
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>✗ {failedStep} step failed</strong>
          <br />
          code: <code style={inlineMono}>{failedCode}</code>
          <br />
          <span style={{ color: 'var(--ink-dim)' }}>{failedHowToFix}</span>
        </div>
      ) : null}
      {refused ? (
        <div
          style={{
            marginBottom: 14,
            padding: '12px 16px',
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--ink)',
          }}
        >
          <strong style={{ color: 'var(--warn)' }}>✗ refused</strong>
          <br />
          This form only runs on a local solo laptop. Detected mode:{' '}
          <code style={inlineMono}>{sp.execMode ?? 'unknown'}</code>.
        </div>
      ) : null}
      <form action={runTeamInitWizardAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--ink-mute)',
          }}
        >
          DATABASE_URL
          <input
            type="text"
            name="databaseUrl"
            placeholder="postgresql://postgres.xxx:PASSWORD@host:5432/postgres"
            required
            style={{ ...fieldInputStyle, marginTop: 6 }}
          />
        </label>
        <label
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--ink-mute)',
          }}
        >
          CLERK SECRET KEY
          <input
            type="password"
            name="clerkSecretKey"
            placeholder="sk_test_… or sk_live_…"
            required
            style={{ ...fieldInputStyle, marginTop: 6 }}
          />
        </label>
        <label
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--ink-mute)',
          }}
        >
          ORG ID (optional — skip the picker)
          <input
            type="text"
            name="orgId"
            placeholder="org_… (leave empty for the wizard to ask)"
            style={{ ...fieldInputStyle, marginTop: 6 }}
          />
        </label>
        <button
          type="submit"
          className="btn btn--accent"
          style={{ width: 'fit-content', marginTop: 4 }}
          formNoValidate={false}
        >
          Run wizard
        </button>
      </form>
    </details>
  );
}
