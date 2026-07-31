import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { initProjectAction } from '@/lib/actions/init';
import { resolveDeploymentMode } from '@/lib/deployment-mode';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
  readonly cwd?: string;
  readonly projectSlug?: string;
}

export default async function InitWizardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // /init registers a local repo and writes project-local `.coodra/` state.
  // None of that exists on a team-hosted deployment server. Hide the page so
  // sidebar links / "New project" CTAs don't dead-end on a 500.
  if (resolveDeploymentMode() === 'team-hosted') notFound();
  const sp = await searchParams;

  return (
    <>
      <Topbar crumb="New project" crumbPrefix="coodra / init" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/00 · INIT</div>
            <h1 className="head__title">
              New <em>project</em>.
            </h1>
            <p className="head__lede">
              Web parity with <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra init</span>.
              Registers the project and writes{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                {`<cwd>/.coodra/{config.json,manifest.json,recipes/,graphify/,wiki/,work-packs/}`}
              </span>
              .
            </p>
          </div>
          <div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/projects">
                Back to projects
              </Link>
            </div>
          </div>
        </div>

        {sp.error !== undefined ? (
          <Banner tone="warn">
            <strong style={{ color: 'var(--warn)', marginRight: 8 }}>{sp.error}</strong>
            {sp.errorMessage ?? '—'}
          </Banner>
        ) : null}

        <div className="dash-grid">
          {/* Form */}
          <form action={initProjectAction} className="card" style={{ padding: 32 }}>
            <div className="card__head">
              <h2 className="card__title">
                Project <em>details</em>
              </h2>
              <span className="card__role">all required unless marked</span>
            </div>

            <Field
              label="Project root (cwd)"
              name="cwd"
              {...(sp.cwd !== undefined ? { defaultValue: sp.cwd } : {})}
              placeholder="/Users/you/projects/my-app"
              required
              hint="Absolute path. Must contain package.json, pyproject.toml, Cargo.toml, or .git."
            />
            <Field
              label="Project slug"
              name="projectSlug"
              {...(sp.projectSlug !== undefined ? { defaultValue: sp.projectSlug } : {})}
              placeholder="my-app"
              required
              pattern="[a-z0-9_-]+"
              hint="Lowercase letters, digits, underscores, hyphens. 1–64 characters."
            />
            <div style={{ marginTop: 16 }}>
              <button type="submit" className="btn btn--accent" style={{ marginRight: 8 }}>
                Provision project
              </button>
              <Link href="/projects" className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>

          {/* What happens */}
          <div>
            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                What this <em>will do</em>
              </h3>
              <Step title="Create project row" body="Inserts into ~/.coodra/data.db so Coodra can find it." />
              <Step
                title="Create project state"
                body="<cwd>/.coodra/{config.json,manifest.json,recipes/,graphify/,wiki/,work-packs/}."
              />
              <Step title="Seed default policy" body="The 25-rule starter chain. Editable later from /policies." />
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Next <em>steps</em>
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                After provisioning, run{' '}
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                  coodra agent add &lt;agent&gt;
                </span>{' '}
                to install a native agent plugin, then{' '}
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra start</span>.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

function Field(props: {
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly pattern?: string;
  readonly defaultValue?: string;
  readonly hint?: string;
}) {
  const { label, name, placeholder, required, pattern, defaultValue, hint } = props;
  const inputId = `field-${name}`;
  return (
    <div style={{ marginBottom: 18 }}>
      <label htmlFor={inputId} style={fieldLabelStyle}>
        {label}
        {required === true ? <span style={{ color: 'var(--warn)' }}>*</span> : null}
      </label>
      <input
        id={inputId}
        name={name}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(required === true ? { required: true } : {})}
        {...(pattern !== undefined ? { pattern } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        style={fieldInputStyle}
      />
      {hint !== undefined ? (
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
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Step({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--rule)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 400 }}>{title}</span>
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          letterSpacing: '0.04em',
          lineHeight: 1.6,
        }}
      >
        {body}
      </span>
    </div>
  );
}

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
