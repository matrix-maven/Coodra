import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { tryGetActor } from '@/lib/auth';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { resolveEffectiveMode } from '@/lib/team-config';

export const dynamic = 'force-dynamic';

/**
 * `/welcome` — first-run mode picker.
 *
 * Shown when the user lands on the web app without having decided
 * between solo and team. The page is intentionally calm: three big
 * choices (solo / create-team / connect-existing), plain copy, no
 * marketing fluff. The CTA links go to the respective onboarding flow.
 *
 * In `team-hosted` deployments where the visitor is already
 * authenticated (Clerk session has both userId AND orgId), there's no
 * mode picker to show — they already chose this deployment. We render
 * a "you're signed in, here's your dashboard" landing instead so the
 * /welcome bookmark isn't confusing.
 */

export default async function WelcomePage() {
  const dm = resolveDeploymentMode();

  // In team-hosted mode an already-signed-in user shouldn't be picking
  // between solo and team — they're already in the team. Render a
  // calm "you're set, go to dashboard" version instead.
  if (dm === 'team-hosted') {
    const actor = await tryGetActor();
    if (actor !== null && actor.orgId !== '__solo__' && actor.orgId !== 'no-org') {
      return <SignedInRedirectHint orgSlug={actor.orgId} />;
    }
  }

  const mode = resolveEffectiveMode();
  const alreadyTeam = mode === 'team' || dm === 'team-hosted';

  return (
    <>
      <Topbar crumb="Welcome" crumbPrefix="coodra" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · WELCOME</div>
            <h1 className="head__title">
              Pick your <em>path</em>.
            </h1>
            <p className="head__lede">
              Coodra is MIT, fully self-hosted. There is no Coodra-operated service — every team brings their
              own Postgres + Clerk and runs everything on machines they own. Three paths in: solo (no cloud), create
              a new team (you'll be the admin), or connect to an existing team (someone already set it up and gave
              you the bundle).
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>local-first</strong>
              <br />
              MIT · open source
              <br />v 0.1
            </div>
          </div>
        </div>

        {alreadyTeam ? (
          <div
            style={{
              padding: '14px 18px',
              border: '1px solid var(--accent)',
              background: 'var(--accent-glow)',
              marginBottom: 36,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--accent)',
              letterSpacing: '0.06em',
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              justifyContent: 'space-between',
            }}
          >
            <span>● Team mode is already configured on this machine.</span>
            <Link href="/" className="btn btn--sm btn--accent">
              Open dashboard
            </Link>
          </div>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
          <ModeCard
            badge="01 · solo"
            title={
              <>
                Work <em>solo.</em>
              </>
            }
            tagline="One developer, one machine. Zero cloud."
            bullets={[
              'Stays in ~/.coodra/data.db (SQLite).',
              'No accounts, no sign-in, nothing leaves the box.',
              'Everything works offline.',
              'Promote to a team any time, your data carries over.',
            ]}
            need={['Nothing.']}
            cta={{ href: '/onboarding/solo', label: 'Start solo' }}
            ctaTone="accent"
          />

          <ModeCard
            badge="02 · admin"
            title={
              <>
                Create a <em>team.</em>
              </>
            }
            tagline="First admin: provision Postgres + Clerk, hand teammates a credential bundle."
            bullets={[
              'You provision Supabase + Clerk and own them outright.',
              'CLI applies the schema, generates a hook secret.',
              'Your laptop becomes the first machine in the team.',
              'Nothing Coodra-hosted is ever in the picture — fully self-hosted.',
            ]}
            need={[
              'A Supabase project (free tier works).',
              'A Clerk app + an organization you create.',
              '~5 minutes to walk the wizard.',
            ]}
            cta={{ href: '/onboarding/team', label: 'Create new team' }}
            ctaTone="ink"
          />

          <ModeCard
            badge="03 · join"
            title={
              <>
                Connect to <em>existing.</em>
              </>
            }
            tagline="Anyone with a credential bundle: admin-on-new-machine, member, viewer."
            bullets={[
              'Paste the 5-piece bundle your admin shared.',
              'Web validates against your team\'s Postgres in seconds.',
              'No CLI knowledge required — same flow on first machine + replacement.',
              'Your role (admin / member / viewer) lives in Clerk, not on this laptop.',
            ]}
            need={[
              'Your team\'s database URL.',
              'Your own Clerk user id.',
              'The team\'s org id + hook secret.',
              'Clerk publishable + secret keys.',
            ]}
            cta={{ href: '/onboarding/team/join', label: 'Connect to team' }}
            ctaTone="ink"
          />
        </div>

        <div
          style={{
            marginTop: 56,
            padding: '24px 28px',
            border: '1px solid var(--rule)',
            background: 'var(--bg-2)',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 36,
          }}
        >
          <FactRow label="Storage" solo="~/.coodra/data.db" team="local SQLite + your Postgres" />
          <FactRow label="Sign-in" solo="none" team="Clerk JWT against your Clerk app" />
          <FactRow label="Cost to Coodra" solo="$0" team="$0 (you pay Supabase + Clerk directly)" />
        </div>

        <div
          style={{
            marginTop: 36,
            padding: '20px 24px',
            border: '1px solid var(--rule-strong)',
            background: 'transparent',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 9,
              letterSpacing: '0.22em',
              color: 'var(--ink-mute)',
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            About self-hosted team mode
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.7, marginBottom: 8 }}>
            Coodra doesn't operate any service. <strong style={{ color: 'var(--ink)' }}>Your team's identity is
            the tuple (your Supabase project, your Clerk org)</strong>. There's no central directory to look up; the
            credential bundle is the team. That's the trade — you own everything, including the cost of losing the
            credentials if you don't store them safely.
          </p>
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.7 }}>
            "Connect to existing team" works for the same person on a new laptop, a new teammate joining, or a viewer
            who only needs read-only browsing. The role you have inside the team comes from Clerk org membership; the
            local config is just how this machine's daemons know which cloud to talk to.
          </p>
        </div>
      </section>
    </>
  );
}

function ModeCard(props: {
  readonly badge: string;
  readonly title: React.ReactNode;
  readonly tagline: string;
  readonly bullets: ReadonlyArray<string>;
  readonly need: ReadonlyArray<string>;
  readonly cta: { readonly href: string; readonly label: string };
  readonly ctaTone: 'accent' | 'ink';
}) {
  return (
    <div
      style={{
        padding: 36,
        border: '1px solid var(--rule)',
        background: 'var(--bg-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        minHeight: 480,
      }}
    >
      <div>
        <div className="pack__num">{props.badge}</div>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 56, lineHeight: 1, fontWeight: 400, letterSpacing: '-0.02em', marginTop: 12 }}>
          {props.title}
        </h2>
        <p style={{ fontSize: 15, color: 'var(--ink-dim)', marginTop: 14, lineHeight: 1.55 }}>{props.tagline}</p>
      </div>

      <div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 9,
            letterSpacing: '0.22em',
            color: 'var(--ink-mute)',
            textTransform: 'uppercase',
            marginBottom: 14,
          }}
        >
          What you get
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {props.bullets.map((b) => (
            <li
              key={b}
              style={{
                fontSize: 13,
                color: 'var(--ink)',
                lineHeight: 1.55,
                paddingLeft: 18,
                position: 'relative',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 8,
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                }}
              />
              {b}
            </li>
          ))}
        </ul>
      </div>

      <div style={{ marginTop: 'auto' }}>
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
          You’ll need
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {props.need.map((n) => (
            <li
              key={n}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
                lineHeight: 1.6,
              }}
            >
              {n}
            </li>
          ))}
        </ul>
        <Link href={props.cta.href} className={`btn ${props.ctaTone === 'accent' ? 'btn--accent' : ''}`} style={{ display: 'inline-block' }}>
          {props.cta.label}
        </Link>
      </div>
    </div>
  );
}

function FactRow({ label, solo, team }: { readonly label: string; readonly solo: string; readonly team: string }) {
  return (
    <div>
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
        {label}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
          color: 'var(--ink)',
        }}
      >
        <div>
          <span style={{ color: 'var(--ink-mute)' }}>solo: </span>
          {solo}
        </div>
        <div>
          <span style={{ color: 'var(--ink-mute)' }}>team: </span>
          {team}
        </div>
      </div>
    </div>
  );
}

function SignedInRedirectHint({ orgSlug }: { readonly orgSlug: string }) {
  return (
    <>
      <Topbar crumb="Welcome" crumbPrefix="coodra" />
      <section className="screen" style={{ maxWidth: 720 }}>
        <div className="head">
          <div>
            <div className="head__num">/00 · WELCOME</div>
            <h1 className="head__title">
              You're <em>in.</em>
            </h1>
            <p className="head__lede">
              Signed into <strong>{orgSlug}</strong>. This deployment serves a single team — there's no mode picker
              for you to navigate here. Head to the dashboard.
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link href="/" className="btn btn--accent">
            Open dashboard
          </Link>
          <Link href="/settings/team" className="btn">
            Team settings
          </Link>
          <Link href="/settings/account" className="btn btn--ghost">
            Your account
          </Link>
        </div>
      </section>
    </>
  );
}
