import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { uploadPackAction } from '@/lib/actions/packs';
import { listPacks, packsRoot } from '@/lib/queries/packs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

/**
 * /packs/new — freeform feature-pack upload (skill-style).
 *
 * Counterpart to `/init` (full project bootstrap with template) and
 * `/templates` (browse + install templates). This page exists so a
 * user can drop a single markdown file (or paste a body) and have
 * the agent see it as a Feature Pack on the next session — no
 * template, no project required.
 */
export default async function NewPackPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const root = packsRoot(process.cwd());
  const existing = (await listPacks()).map((p) => p.slug);

  return (
    <>
      <Topbar crumb="Upload pack" crumbPrefix="coodra / packs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/04 · KNOWLEDGE · UPLOAD PACK</div>
            <h1 className="head__title">
              Drop in a <em>reference</em>.
            </h1>
            <p className="head__lede">
              A freeform pack is a single markdown file the agent loads as context — a style guide, a domain primer, an
              architectural cheat sheet. No template, no four-file ceremony. Upload a <code style={mono}>.md</code> file
              or paste below; the agent picks it up on the next <code style={mono}>get_feature_pack</code>.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{existing.length} existing</strong>
              <br />
              {root}
              <br />
              freeform · skill-style
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/packs">
                ← back to packs
              </Link>
              <Link className="btn btn--ghost" href="/templates">
                Use a template
              </Link>
            </div>
          </div>
        </div>

        {sp.error !== undefined ? <div className="banner banner--warn">{sp.errorMessage ?? sp.error}</div> : null}

        <div className="card" style={{ padding: 32 }}>
          <div className="card__head" style={{ marginBottom: 24 }}>
            <h2 className="card__title">
              Upload <em>markdown</em>
            </h2>
            <span className="card__role">slug · file or paste · meta is auto-written</span>
          </div>

          {/* Server Actions set encType automatically; specifying it here would
              be overridden + warns at runtime in Next 15. File upload still
              works — React encodes multipart when an <input type="file"> is
              present in the form. */}
          <form action={uploadPackAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field
              label="Slug"
              name="slug"
              placeholder="e.g. typescript-style-guide"
              required
              hint="Lowercase letters, digits, hyphens or underscores. Becomes the directory name."
            />

            <Field
              label="Parent slug (optional)"
              name="parentSlug"
              placeholder="e.g. typescript"
              hint="If this pack extends another, name the parent here. Inheritance is resolved at load time."
            />

            <div className="field">
              <label style={fieldLabelStyle}>Markdown file</label>
              <input
                type="file"
                name="file"
                accept=".md,.markdown,text/markdown,text/plain"
                style={{
                  display: 'block',
                  padding: '10px 12px',
                  background: 'var(--bg)',
                  border: '1px solid var(--rule-strong)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  width: '100%',
                }}
              />
              <p style={hintStyle}>
                Pick a <code style={mono}>.md</code> file (under 2 MB). If a file is attached, it overrides the paste
                below.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={dividerLineStyle} />
              <span style={dividerLabelStyle}>or paste</span>
              <span style={dividerLineStyle} />
            </div>

            <div className="field">
              <label style={fieldLabelStyle}>Markdown body</label>
              <textarea
                name="content"
                placeholder={
                  '# my-pack\n\nA reference document the agent will load as context.\n\n## Section\n\n- bullet\n- bullet'
                }
                rows={14}
                style={{
                  width: '100%',
                  padding: '12px 14px',
                  background: 'var(--bg)',
                  border: '1px solid var(--rule-strong)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  letterSpacing: '0.02em',
                  lineHeight: 1.6,
                  resize: 'vertical',
                }}
              />
              <p style={hintStyle}>
                Goes to <code style={mono}>{root}/&lt;slug&gt;/spec.md</code>. The detail page renders it as the spec
                section. A minimal <code style={mono}>meta.json</code> with{' '}
                <code style={mono}>{'{ kind: "freeform" }'}</code> is written alongside.
              </p>
            </div>

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
              Overwrite if a pack with this slug already exists
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="submit" className="btn btn--accent">
                Upload pack
              </button>
              <Link href="/packs" className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>

        {existing.length > 0 ? (
          <div className="aside-card" style={{ marginTop: 24 }}>
            <div className="aside-card__head">
              <h3 className="aside-card__title">
                Existing <em>slugs</em>
              </h3>
              <span className="card__role">avoid collisions · {existing.length}</span>
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
                lineHeight: 1.9,
              }}
            >
              {existing.join(' · ')}
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  hint,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="field">
      <label style={fieldLabelStyle}>{label}</label>
      <input
        name={name}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(required === true ? { required: true } : {})}
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
      {hint !== undefined ? <p style={hintStyle}>{hint}</p> : null}
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

const hintStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-mute)',
  letterSpacing: '0.04em',
  marginTop: 6,
  marginBottom: 0,
  lineHeight: 1.6,
};

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};

const dividerLineStyle: React.CSSProperties = {
  flex: 1,
  height: 1,
  background: 'var(--rule)',
};

const dividerLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
};
