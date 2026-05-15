import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { Topbar } from '@/components/Topbar';
import { getActor } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const actor = await getActor();
  const mode = actor.mode;
  const home = process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');

  return (
    <>
      <Topbar crumb="Settings" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · SYSTEM · SETTINGS</div>
            <h1 className="head__title">
              <em>Local-first</em> by design.
            </h1>
            <p className="head__lede">
              Solo mode is the default. No keys, no cloud, no telemetry. Team mode flips when you have a Clerk tenant
              and a self-hosted Postgres reachable. Everything else stays the same.
            </p>
          </div>
        </div>

        <div className="dash-grid">
          <div>
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 18 }}>
                Mode
              </h3>
              <div style={modeGrid}>
                <ModeBtn title="Solo" sub="Local · default" active={mode === 'solo'} />
                <ModeBtn title="Team" sub="Cloud sync" active={mode === 'team'} />
                <ModeBtn title="Org" sub="Soon" disabled />
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--ink-mute)',
                  letterSpacing: '0.06em',
                  marginTop: 14,
                }}
              >
                Switch by setting <strong style={{ color: 'var(--ink)' }}>COODRA_MODE</strong> in{' '}
                <span style={{ color: 'var(--ink)' }}>.env.local</span> and restarting the dev server.
              </div>
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Identity
              </h3>
              <KV k="user.id" v={actor.userId} />
              <KV k="user.org" v={actor.orgId} />
              <KV k="hook secret" v="••••••••••••••••" />
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Cloud · <em>team mode</em>
              </h3>
              <KV k="DATABASE_URL" v={process.env.DATABASE_URL ? 'configured' : 'unset'} />
              <KV k="Clerk publishable" v={process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? 'configured' : 'unset'} />
              <KV k="Supabase project" v={process.env.SUPABASE_PROJECT_REF ?? 'unset'} />
            </div>
          </div>

          <div>
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Defaults
              </h3>
              <ToggleRow title="Auto-pack on SessionEnd" sub="FIRES PATTERN-20 INJECTOR" on />
              <ToggleRow title="Inject feature packs at SessionStart" sub="PROJECT-SCOPED · PARENT CHAIN" on />
              <ToggleRow title="Telemetry" sub="NONE · BY DESIGN" />
              <ToggleRow title="Doctor · auto-fix on init" sub="SAFE FIXES ONLY" />
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Storage
              </h3>
              <KV k="COODRA_HOME" v={home} />
              <KV k="LOG_LEVEL" v={process.env.LOG_LEVEL ?? 'info'} />
              <KV k="MCP port" v={process.env.MCP_SERVER_PORT ?? '3100'} />
              <KV k="Bridge port" v={process.env.HOOKS_BRIDGE_PORT ?? '3101'} />
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Danger zone
              </h3>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--ink-dim)', marginBottom: 18 }}>
                These actions cannot be undone. The CLI requires{' '}
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--warn)' }}>--force</span>; the web app is
                read-only here in v2.
              </p>
              <button
                className="btn btn--ghost"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)', width: '100%', marginBottom: 6 }}
                type="button"
                disabled
              >
                Reset doctor cache
              </button>
              <button
                className="btn btn--ghost"
                style={{ borderColor: 'var(--warn)', color: 'var(--warn)', width: '100%' }}
                type="button"
                disabled
              >
                Wipe local audit data
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const modeGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr',
  gap: 8,
  marginBottom: 0,
};

function ModeBtn({
  title,
  sub,
  active,
  disabled,
}: {
  title: string;
  sub: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        padding: '16px 12px',
        background: active ? 'var(--accent-glow)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--rule-strong)'}`,
        textAlign: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 400 }}>
        {active ? <em style={{ color: 'var(--accent)', fontStyle: 'italic' }}>{title}</em> : title}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          color: 'var(--ink-mute)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          marginTop: 6,
        }}
      >
        {sub}
      </div>
    </div>
  );
}

function ToggleRow({ title, sub, on }: { title: string; sub: string; on?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 0',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div>
        <div style={{ fontSize: 14 }}>{title}</div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink-mute)',
            letterSpacing: '0.06em',
            marginTop: 3,
          }}
        >
          {sub}
        </div>
      </div>
      <span className={`badge ${on ? 'badge--ok' : ''}`}>
        <span className="badge__dot"></span>
        {on ? 'ON' : 'OFF'}
      </span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-dim)',
        padding: '10px 0',
        borderBottom: '1px solid var(--rule)',
        gap: 16,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
      <span
        style={{
          color: 'var(--ink)',
          flexShrink: 0,
          maxWidth: '60%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {v}
      </span>
    </div>
  );
}
