import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

/**
 * `/onboarding/solo` — solo mode is opt-out by default; this page exists
 * so the welcome → solo branch lands somewhere intentional rather than
 * just bouncing to dashboard. Two roles:
 *
 *   1. Confirm the user that solo mode needs nothing else from them.
 *   2. Tell them the next operational step: `coodra init` in their
 *      first project, then open Claude Code to see traces flow in.
 *
 * If a project already exists, we show "you already have N projects"
 * + a deep link to the dashboard so we don't insist on init-again.
 */

export default async function SoloOnboardingPage() {
  // Solo onboarding is local-only by definition. On a team-hosted
  // deployment the visitor is by definition not in solo mode.
  if (resolveDeploymentMode() === 'team-hosted') notFound();
  const projects = await safeListProjects();
  const hasProject = projects.length > 0;

  return (
    <>
      <Topbar crumb="Solo mode" crumbPrefix="coodra / onboarding" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · SOLO ONBOARDING</div>
            <h1 className="head__title">
              You’re <em>set</em>.
            </h1>
            <p className="head__lede">
              Solo mode runs entirely on this machine. No accounts, no cloud, no setup remaining. Coodra is already
              listening on <code style={inlineMono}>~/.coodra/data.db</code> for whatever your agent does next.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>local-only</strong>
              <br />
              ~/.coodra/data.db
              <br />v 0.1
            </div>
            <div className="head__actions">
              <Link href="/welcome" className="btn btn--ghost">
                Switch to team
              </Link>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 32, alignItems: 'start' }}>
          <div className="card" style={{ padding: 36 }}>
            <h2 className="card__title" style={{ marginBottom: 16 }}>
              {hasProject ? (
                <>
                  Your <em>workspace</em> is ready.
                </>
              ) : (
                <>
                  Add your first <em>project</em>.
                </>
              )}
            </h2>

            {hasProject ? (
              <>
                <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 24 }}>
                  You already have <strong style={{ color: 'var(--ink)' }}>{projects.length}</strong> project
                  {projects.length === 1 ? '' : 's'} registered. Open the dashboard to see runs / decisions / packs flow
                  in as your agent works.
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <Link href="/" className="btn btn--accent">
                    Open dashboard
                  </Link>
                  <Link href="/projects" className="btn">
                    All projects
                  </Link>
                  <Link href="/init" className="btn btn--ghost">
                    Add another project
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.65, marginBottom: 24 }}>
                  Two ways to register a project:
                </p>

                <SoloOption
                  num="01"
                  title={
                    <>
                      From <em>this app</em>
                    </>
                  }
                  body="Click below — fills in a small form, registers the project in your local DB, scaffolds a feature pack, wires the Claude Code hooks."
                  cta={{ href: '/init', label: 'New project' }}
                  primary
                />
                <SoloOption
                  num="02"
                  title={
                    <>
                      From the <em>terminal</em>
                    </>
                  }
                  body="cd into your repo, run the command. Same outcome; some users prefer staying in the shell."
                  code="coodra init --slug my-app --ide claude"
                />
              </>
            )}
          </div>

          <div>
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Then <em>open</em> Claude Code
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65 }}>
                Open your repo in Claude Code, Cursor, or Windsurf. The first session will hit{' '}
                <code style={inlineMono}>coodra start</code> and traces appear here in real-time. Decisions and
                context packs land in <code style={inlineMono}>~/.coodra/data.db</code>; future sessions read them on
                start so the agent has prior context before writing new code.
              </p>
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Where things <em>live</em>
              </h3>
              <FactRow label="Database" value="~/.coodra/data.db" />
              <FactRow label="Logs" value="~/.coodra/logs/" />
              <FactRow label="Per-project" value="<repo>/docs/feature-packs/" />
              <FactRow label="Hooks" value="~/.claude/settings.json" last />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

async function safeListProjects() {
  try {
    return await listProjects();
  } catch {
    return [];
  }
}

function SoloOption(props: {
  readonly num: string;
  readonly title: React.ReactNode;
  readonly body: string;
  readonly cta?: { readonly href: string; readonly label: string };
  readonly code?: string;
  readonly primary?: boolean;
}) {
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
          {props.num}
        </span>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400, letterSpacing: '-0.005em' }}>
          {props.title}
        </span>
      </div>
      <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65, paddingLeft: 50, marginBottom: 14 }}>
        {props.body}
      </p>
      {props.cta !== undefined ? (
        <div style={{ paddingLeft: 50 }}>
          <Link href={props.cta.href} className={`btn ${props.primary === true ? 'btn--accent' : ''}`}>
            {props.cta.label}
          </Link>
        </div>
      ) : null}
      {props.code !== undefined ? (
        <pre
          style={{
            marginLeft: 50,
            background: 'var(--bg)',
            border: '1px solid var(--rule)',
            padding: '14px 18px',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--ink)',
            letterSpacing: '0.04em',
            overflowX: 'auto',
          }}
        >
          {props.code}
        </pre>
      ) : null}
    </div>
  );
}

function FactRow({ label, value, last }: { readonly label: string; readonly value: string; readonly last?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: 12,
        padding: '10px 0',
        borderBottom: last === true ? 'none' : '1px solid var(--rule)',
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
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--ink)',
          letterSpacing: '0.04em',
        }}
      >
        {value}
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
