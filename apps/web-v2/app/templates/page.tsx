import { Topbar } from '@/components/Topbar';
import { installTemplateFromPathAction } from '@/lib/actions/templates';
import { listTemplates } from '@/lib/queries/templates';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly installed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const templates = listTemplates();

  return (
    <>
      <Topbar crumb="Templates" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/04 · KNOWLEDGE · TEMPLATES</div>
            <h1 className="head__title">
              Start from a <em>known shape</em>.
            </h1>
            <p className="head__lede">
              Templates ship with policy seeds, hook scripts, and a starter feature pack. Pick one — the CLI does the
              rest.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{templates.length} bundled</strong>
              <br />
              packages/cli/templates/
              <br />
              ~/.contextos/templates/
            </div>
          </div>
        </div>

        {sp.installed !== undefined ? <Banner tone="ok">Installed template · {sp.installed}</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {templates.length === 0 ? (
          <div className="empty">
            <strong>
              No templates <em>found</em>.
            </strong>
            Drop one under{' '}
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
              ~/.contextos/templates/&lt;name&gt;/
            </span>{' '}
            with a template.json, or install one below.
          </div>
        ) : (
          <div className="tpl-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 24 }}>
            {templates.map((t) => (
              <div key={`${t.source}:${t.name}`} className="tpl" style={tplStyle}>
                <div className="tpl__head" style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                  <div className="tpl__icon" style={tplIconStyle}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" width={24} height={24}>
                      <rect x="3" y="3" width="8" height="8" />
                      <rect x="13" y="3" width="8" height="8" />
                      <rect x="3" y="13" width="8" height="8" />
                      <rect x="13" y="13" width="8" height="8" />
                    </svg>
                  </div>
                  <h3
                    className="tpl__title"
                    style={{ fontFamily: 'var(--serif)', fontSize: 28, fontWeight: 400, margin: 0 }}
                  >
                    {t.source} · <em>{t.name}</em>
                  </h3>
                </div>
                <p className="tpl__desc" style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--ink-dim)', flex: 1 }}>
                  {t.description ?? 'No description provided.'}
                </p>
                <div
                  className="tpl__foot"
                  style={{
                    marginTop: 28,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <span
                    className="tpl__hooks"
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-mute)',
                      letterSpacing: '0.1em',
                    }}
                  >
                    {t.languages.join(' · ').toUpperCase() || 'GENERIC'} · v{t.version ?? '—'}
                  </span>
                  <span className="badge">
                    <span className="badge__dot"></span>
                    {t.source.toUpperCase()}
                  </span>
                </div>
                {t.dir !== undefined ? (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 12,
                      borderTop: '1px solid var(--rule)',
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--ink-mute)',
                      letterSpacing: '0.04em',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={t.dir}
                  >
                    {t.dir}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {/* Install-from-path form */}
        <div className="card" style={{ padding: 28, marginTop: 32 }}>
          <div className="card__head">
            <h2 className="card__title">
              Install <em>from path</em>
            </h2>
            <span className="card__role">absolute path · template.json required</span>
          </div>
          <form action={installTemplateFromPathAction} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* projectSlug is required by the action schema but we don't carry one in v2's flat IA — pass __global__ */}
            <input type="hidden" name="projectSlug" value="__global__" />
            <Field label="Source path" name="source" placeholder="/Users/you/path/to/template-dir" required />
            <Field label="Name override (optional)" name="name" placeholder="my-custom-template" />
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
              }}
            >
              <input type="checkbox" name="force" />
              Force overwrite if a user template with this name exists
            </label>
            <button type="submit" className="btn btn--accent" style={{ width: 'fit-content' }}>
              Install template
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

const tplStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--rule)',
  padding: 36,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 280,
};

const tplIconStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  border: '1px solid var(--rule-strong)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--accent)',
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
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 6,
          display: 'block',
        }}
      >
        {label}
      </label>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        style={{
          width: '100%',
          padding: '10px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--rule-strong)',
          color: 'var(--ink)',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          letterSpacing: '0.04em',
        }}
      />
    </div>
  );
}
