import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { DescriptionQualityHint } from '@/components/features/DescriptionQualityHint';
import { createFeatureAction } from '@/lib/actions/features';
import { resolveProjectFromParams } from '@/lib/project-context';
import { featuresRootForProject, walkProjectFeatures } from '@/lib/queries/features';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function NewFeaturePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const projectCwd = project.cwd ?? process.cwd();
  const root = featuresRootForProject(projectCwd);
  const existing = walkProjectFeatures(projectCwd).map((r) => r.slug);

  return (
    <>
      <Topbar
        crumb={`${project.slug} / features / new`}
        crumbPrefix="contextos / projects"
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()} · NEW FEATURE</div>
            <h1 className="head__title">
              Define a <em>feature</em>.
            </h1>
            <p className="head__lede">
              Pick a slug, write a one-sentence trigger description, and (optionally) drop in supporting files. The
              agent reads the trigger to decide whether to load this feature; the body + files are loaded on demand.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{existing.length} existing</strong>
              <br />
              {root}
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                ← back to features
              </Link>
            </div>
          </div>
        </div>

        {sp.error !== undefined ? (
          <div
            style={{
              padding: '12px 16px',
              marginBottom: 24,
              border: '1px solid var(--warn)',
              background: 'var(--warn-glow)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--warn)',
            }}
          >
            {sp.errorMessage ?? sp.error}
          </div>
        ) : null}

        <div className="card" style={{ padding: 32 }}>
          <form action={createFeatureAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <input type="hidden" name="projectSlug" value={project.slug} />

            <Field
              label="Slug"
              name="slug"
              required
              placeholder="payments-flow"
              hint="Lowercase letters, digits, hyphens or underscores. Becomes the directory name under docs/features/."
            />

            <Field
              label="Description (the agent's trigger)"
              name="description"
              required
              placeholder="Use this when working on /src/payments.ts — Stripe charges, refunds, webhook signing."
              hint="Aim for 1-2 sentences that name concrete operations or files. Starts with 'Use this when...'."
              multiline
            />
            <DescriptionQualityHint inputId="new-feature-description" />

            <Field
              label="When NOT to use (optional)"
              name="whenNotToUse"
              placeholder="Skip for non-Stripe payment paths (PayPal lives under `paypal-flow`)."
              multiline
            />

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="new-feature-maturity">
                Maturity
              </label>
              <select
                id="new-feature-maturity"
                name="maturity"
                defaultValue="draft"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  background: 'var(--bg)',
                  border: '1px solid var(--rule-strong)',
                  color: 'var(--ink)',
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                }}
              >
                <option value="draft">draft</option>
                <option value="beta">beta</option>
                <option value="stable">stable</option>
                <option value="deprecated">deprecated</option>
              </select>
            </div>

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="new-feature-body">
                Body (markdown — optional)
              </label>
              <textarea
                id="new-feature-body"
                name="body"
                rows={12}
                placeholder={
                  '# my-feature\n\n## What this feature is\n\n...\n\n## Concrete operations / entities\n\n- ...\n'
                }
                style={textareaStyle}
              />
              <p style={hintStyle}>
                Free-form markdown. Loaded by <code style={mono}>contextos__get_feature</code> on demand. Leave blank to
                use the scaffold.
              </p>
            </div>

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="new-feature-files">
                Supporting files (optional)
              </label>
              <input
                id="new-feature-files"
                type="file"
                name="files"
                multiple
                accept=".md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.sql,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rs,.go,.java,.rb,.sh,.bash,.zsh,.html,.css,.xml"
                style={fileInputStyle}
              />
              <p style={hintStyle}>
                Multi-select. Cap: 256 KB per file. Allowed extensions match the MCP{' '}
                <code style={mono}>get_feature_file</code> tool exactly.
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
              }}
            >
              <input type="checkbox" name="force" />
              Force overwrite if a feature with this slug already exists
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="submit" className="btn btn--accent">
                Create feature
              </button>
              <Link href={`/projects/${encodeURIComponent(project.slug)}/features`} className="btn btn--ghost">
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
              <span className="card__role">{existing.length}</span>
            </div>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
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
  multiline,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  multiline?: boolean;
}) {
  const id = `new-feature-${name}`;
  return (
    <div className="field">
      <label htmlFor={id} style={fieldLabelStyle}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(required === true ? { required: true } : {})}
          style={textareaStyle}
        />
      ) : (
        <input
          id={id}
          name={name}
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(required === true ? { required: true } : {})}
          style={textInputStyle}
        />
      )}
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

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.6,
  resize: 'vertical',
};

const fileInputStyle: React.CSSProperties = {
  display: 'block',
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  width: '100%',
};

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
