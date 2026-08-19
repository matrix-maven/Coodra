import Link from 'next/link';

import { DescriptionQualityHint } from '@/components/features/DescriptionQualityHint';
import { Topbar } from '@/components/Topbar';
import { createFeatureAction } from '@/lib/actions/features';
import { listGlobalFeatures } from '@/lib/queries/features-list';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function NewGlobalFeaturePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [features, sp] = await Promise.all([listGlobalFeatures(), searchParams]);
  const existing = features.map((feature) => feature.slug).sort();

  return (
    <>
      <Topbar crumb="Global Agent Recipes / new" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · KNOWLEDGE · NEW GLOBAL AGENT RECIPE</div>
            <h1 className="head__title">
              Define a <em>global recipe</em>.
            </h1>
            <p className="head__lede">
              Global recipes are workspace-level guidance. They are stored in Coodra&apos;s global scope and do not use
              a project checkout or supporting files.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{existing.length} existing</strong>
              <br />
              global scope
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href="/recipes/new">
                ← choose scope
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
            <input type="hidden" name="projectSlug" value="__global__" />

            <Field
              label="Slug"
              name="slug"
              required
              placeholder="release-discipline"
              hint="Lowercase letters, digits, hyphens or underscores. Must be unique in global scope."
            />

            <Field
              label="Description (the agent's trigger)"
              name="description"
              required
              placeholder="Use this when preparing any public release across Matrix Maven projects."
              hint="Aim for 1-2 sentences that name concrete operations. Starts with 'Use this when...'."
              multiline
            />
            <DescriptionQualityHint inputId="new-feature-description" />

            <Field
              label="When NOT to use (optional)"
              name="whenNotToUse"
              placeholder="Skip when the task is specific to one repository's architecture."
              multiline
            />

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="new-feature-maturity">
                Maturity
              </label>
              <select id="new-feature-maturity" name="maturity" defaultValue="draft" style={textInputStyle}>
                <option value="draft">draft</option>
                <option value="beta">beta</option>
                <option value="stable">stable</option>
                <option value="deprecated">deprecated</option>
              </select>
            </div>

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="new-feature-body">
                Body (markdown)
              </label>
              <textarea id="new-feature-body" name="body" rows={12} style={textareaStyle} />
              <p style={hintStyle}>Free-form markdown loaded from the global recipe detail.</p>
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
              Force overwrite if a global Agent Recipe with this slug already exists
            </label>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="submit" className="btn btn--accent">
                Create global recipe
              </button>
              <Link href="/recipes/global" className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>
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
