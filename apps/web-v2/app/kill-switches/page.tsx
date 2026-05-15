import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { pauseAction, resumeAction } from '@/lib/actions/kill-switches';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { listActive } from '@/lib/queries/kill-switches';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

export default async function KillSwitchesPage({
  searchParams,
}: {
  searchParams: Promise<{
    paused?: string;
    resumed?: string;
    duplicate?: string;
    error?: string;
    project?: string;
  }>;
}) {
  const sp = await searchParams;
  const [allActive, projects] = await Promise.all([listActive(), listProjects()]);
  const scopedSlug = sp.project !== undefined && sp.project !== '' ? sp.project : null;
  const active =
    scopedSlug === null
      ? allActive
      : allActive.filter((k) => k.scope === 'global' || (k.scope === 'project' && k.target === scopedSlug));

  return (
    <>
      <Topbar crumb="Kill switches" crumbPrefix={scopedSlug !== null ? `coodra / ${scopedSlug}` : 'coodra'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              /03 · GOVERN · KILL SWITCHES{scopedSlug !== null ? ` · ${scopedSlug.toUpperCase()}` : ''}
            </div>
            <h1 className="head__title">
              Stop work, <em>fast</em>.
            </h1>
            <p className="head__lede">
              A kill switch sits in front of the policy chain. Pause one project, one tool, or every agent. Hard mode
              denies everything; soft mode warns. Toggle anytime; agents see it before their next call.
              {scopedSlug !== null ? (
                <>
                  {' Scoped to '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>{scopedSlug}</span>
                  {' (project-scope + global) — '}
                  <Link href="/kill-switches" style={{ textDecoration: 'underline', color: 'var(--ink-dim)' }}>
                    show all
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{active.length} active</strong>
              <br />
              {active.length === 0 ? 'no paused agents' : 'agents paused'}
              <br />
              {scopedSlug !== null ? scopedSlug : `${projects.length} projects`}
            </div>
          </div>
        </div>

        {sp.paused !== undefined ? <Banner tone="ok">Paused · {sp.paused.slice(0, 8)}</Banner> : null}
        {sp.resumed !== undefined ? <Banner tone="ok">Resumed · {sp.resumed.slice(0, 8)}</Banner> : null}
        {sp.duplicate !== undefined ? (
          <Banner tone="warn">
            Duplicate active switch already exists ({sp.duplicate.slice(0, 8)}); submit again with force=true to
            override.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">Error: {sp.error}</Banner> : null}

        <div className="ks-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div className="ks-panel" style={panelStyle}>
            <div className="card__head">
              <h2 className="card__title">
                Pause an <em>agent</em>
              </h2>
              <span className="card__role">scope · target · mode</span>
            </div>

            <form action={pauseAction}>
              <SelectField label="Mode" name="mode" options={['hard', 'soft']} />
              <SelectField
                label="Scope"
                name="scope"
                options={['global', 'project', 'tool', 'agent_type']}
                {...(scopedSlug !== null ? { defaultValue: 'project' } : {})}
              />
              <Field
                label="Target (slug / tool / agent type)"
                name="target"
                placeholder="e.g. coodra · bash · cursor"
                {...(scopedSlug !== null ? { defaultValue: scopedSlug } : {})}
              />
              <Field
                label="Reason"
                name="reason"
                placeholder="Production deploy in progress; locking writes."
                required
                textarea
              />
              <Field label="Expires at (ISO, optional)" name="expiresAt" placeholder="2026-05-08T03:00:00Z" />
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn--accent" type="submit" style={{ flex: 1 }}>
                  Pause now
                </button>
                <button className="btn btn--ghost" type="submit" name="force" value="true">
                  Force
                </button>
              </div>
            </form>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Active <em>switches</em>
                </h3>
                <span className={`badge ${active.length === 0 ? 'badge--ok' : 'badge--warn'}`}>
                  <span className="badge__dot"></span>
                  {active.length === 0 ? 'NONE' : `${active.length} ACTIVE`}
                </span>
              </div>
              {active.length === 0 ? (
                <div
                  style={{
                    lineHeight: 1.6,
                    color: 'var(--ink-dim)',
                    padding: '24px 0',
                    textAlign: 'center',
                    border: '1px dashed var(--rule)',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    letterSpacing: '0.05em',
                  }}
                >
                  No agents are paused.
                </div>
              ) : (
                active.map((ks, i) => (
                  <div key={ks.id} className="event" style={i === 0 ? undefined : { marginTop: 6 }}>
                    <div className={`event__dot ${ks.mode === 'hard' ? 'event__dot--warn' : ''}`}></div>
                    <div className="event__time">{fmtClockSec(ks.pausedAt)}</div>
                    <div className="event__tool">
                      {ks.mode} ·{' '}
                      <b>
                        {ks.scope}
                        {ks.target ? `:${ks.target}` : ''}
                      </b>
                    </div>
                    <div className="event__dur">{fmtRelative(ks.pausedAt)}</div>
                    <form action={resumeAction}>
                      <input type="hidden" name="id" value={ks.id} />
                      <button className="btn btn--sm btn--ghost" type="submit">
                        Resume
                      </button>
                    </form>
                  </div>
                ))
              )}
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                What gets <em>denied</em>?
              </h3>
              <div style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--accent)' }}>Hard</strong> — every tool call denied with the reason.
                <br />
                <strong style={{ color: 'var(--caution)' }}>Soft</strong> — call still runs; agent sees a warning.
                <br />
                <br />
                Switches expire automatically when <span style={{ fontFamily: 'var(--mono)' }}>expiresAt</span> passes,
                or resume manually above.
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--rule)',
  padding: 32,
};

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

function Field({
  label,
  name,
  placeholder,
  required,
  textarea,
  defaultValue,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  textarea?: boolean;
  defaultValue?: string;
}) {
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label className="field__label" style={fieldLabelStyle}>
        {label}
      </label>
      {textarea ? (
        <textarea
          name={name}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(required === true ? { required: true } : {})}
          {...(defaultValue !== undefined ? { defaultValue } : {})}
          rows={2}
          style={fieldInputStyle}
        />
      ) : (
        <input
          name={name}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(required === true ? { required: true } : {})}
          {...(defaultValue !== undefined ? { defaultValue } : {})}
          style={fieldInputStyle}
        />
      )}
    </div>
  );
}

function SelectField({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: ReadonlyArray<string>;
  defaultValue?: string;
}) {
  return (
    <div className="field" style={{ marginBottom: 14 }}>
      <label className="field__label" style={fieldLabelStyle}>
        {label}
      </label>
      <select name={name} {...(defaultValue !== undefined ? { defaultValue } : {})} style={fieldInputStyle}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

const fieldLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
  marginBottom: 6,
  display: 'block',
};

const fieldInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
};
