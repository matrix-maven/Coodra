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
  readonly ide?: string;
  readonly template?: string;
}

const BUNDLED_TEMPLATES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'Minimal — skeleton (no template overlay)' },
  { value: 'generic', label: 'generic' },
  { value: 'nextjs-saas', label: 'nextjs-saas' },
  { value: 'node-monorepo', label: 'node-monorepo' },
  { value: 'python-fastapi', label: 'python-fastapi' },
  { value: 'python-ml', label: 'python-ml' },
  { value: 'rust-cli', label: 'rust-cli' },
  { value: 'go-service', label: 'go-service' },
];

const IDE_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'claude', label: 'claude — wires ~/.claude/settings.json' },
  { value: 'cursor', label: 'cursor (M07)' },
  { value: 'windsurf', label: 'windsurf (M07)' },
  { value: 'all', label: 'all detected' },
];

export default async function InitWizardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  // /init writes ~/.coodra/, .mcp.json, scaffolds docs/feature-packs/
  // on the local repo — none of which exist on a team-hosted deployment
  // server. Hide the page so sidebar links / "New project" CTAs don't
  // dead-end on a 500.
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
              Provisions <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>~/.coodra/data.db</span>
              , scaffolds a feature pack at{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                {`<cwd>/docs/feature-packs/<slug>/`}
              </span>
              , registers the project + default policy + Claude Code hook entries.
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
            <SelectField
              label="IDE to wire"
              name="ide"
              defaultValue={sp.ide ?? 'claude'}
              options={IDE_OPTIONS}
              hint="claude wires hook entries in ~/.claude/settings.json. cursor + windsurf land in M07."
            />
            <SelectField
              label="Feature-pack template"
              name="template"
              defaultValue={sp.template ?? ''}
              options={BUNDLED_TEMPLATES}
              hint="Optional — picks a starter template for the auto-marker sections. Skipping = minimal skeleton."
            />

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
                padding: '14px 0',
                borderTop: '1px solid var(--rule)',
                marginTop: 8,
              }}
            >
              <input type="checkbox" name="noGraphify" defaultChecked />
              Skip Graphify scan (default — install graphify CLI separately if needed)
            </label>

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
              <Step title="Create project row" body="Inserts into ~/.coodra/data.db so MCP + bridge can find it." />
              <Step
                title="Scaffold feature pack"
                body="<cwd>/docs/feature-packs/<slug>/{spec,implementation,techstack}.md."
              />
              <Step title="Seed default policy" body="The 25-rule starter chain. Editable later from /policies." />
              <Step
                title="Wire Claude hooks"
                body="Adds PreToolUse + PostToolUse + SessionStart + SessionEnd entries."
              />
            </div>

            <div className="aside-card">
              <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
                Next <em>steps</em>
              </h3>
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                After provisioning, open Claude Code in your repo. The first session will hit{' '}
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra start</span> and surface
                events on this dashboard in real-time.
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
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={fieldLabelStyle}>
        {label}
        {required === true ? <span style={{ color: 'var(--warn)' }}>*</span> : null}
      </label>
      <input
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

function SelectField({
  label,
  name,
  options,
  defaultValue,
  hint,
}: {
  readonly label: string;
  readonly name: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly defaultValue?: string;
  readonly hint?: string;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <label style={fieldLabelStyle}>{label}</label>
      <select name={name} defaultValue={defaultValue} style={fieldInputStyle}>
        {options.map((opt) => (
          <option key={opt.value || '_none'} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
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
