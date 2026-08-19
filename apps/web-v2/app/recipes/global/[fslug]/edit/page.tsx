import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { editFeatureMetaAction, removeFeatureAction } from '@/lib/actions/features';
import { getGlobalFeature } from '@/lib/queries/features-list';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function EditGlobalFeaturePage({
  params,
  searchParams,
}: {
  params: Promise<{ fslug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ fslug }, sp] = await Promise.all([params, searchParams]);
  const recipe = await getGlobalFeature(decodeURIComponent(fslug));
  if (recipe === null) notFound();

  const fm = recipe.frontmatter;
  const recipeUrl = `/recipes/global/${encodeURIComponent(recipe.slug)}`;

  return (
    <>
      <Topbar crumb={`global / Agent Recipes / ${recipe.slug} / edit`} crumbPrefix="coodra / recipes" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · GLOBAL · EDIT AGENT RECIPE</div>
            <h1 className="head__title">
              Edit <em>{recipe.slug}</em>.
            </h1>
            <p className="head__lede">Update the global trigger metadata and markdown body.</p>
          </div>
          <div className="head__actions">
            <Link className="btn btn--ghost" href={recipeUrl}>
              ← back to recipe
            </Link>
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
          <form action={editFeatureMetaAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <input type="hidden" name="projectSlug" value="__global__" />
            <input type="hidden" name="fslug" value={recipe.slug} />

            <Field
              label="Description (the agent's trigger)"
              name="description"
              defaultValue={fm.description}
              required
              multiline
            />
            <Field label="When NOT to use" name="whenNotToUse" defaultValue={fm.whenNotToUse ?? ''} multiline />

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="edit-feature-maturity">
                Maturity
              </label>
              <select
                id="edit-feature-maturity"
                name="maturity"
                defaultValue={fm.maturity ?? 'draft'}
                style={textInputStyle}
              >
                <option value="draft">draft</option>
                <option value="beta">beta</option>
                <option value="stable">stable</option>
                <option value="deprecated">deprecated</option>
              </select>
            </div>

            <div className="field">
              <label style={fieldLabelStyle} htmlFor="edit-feature-body">
                Body (markdown)
              </label>
              <textarea id="edit-feature-body" name="body" rows={18} defaultValue={recipe.body} style={textareaStyle} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button type="submit" className="btn btn--accent">
                Save changes
              </button>
              <Link href={recipeUrl} className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>

        <div className="aside-card" style={{ marginTop: 24 }}>
          <div className="aside-card__head">
            <h3 className="aside-card__title">
              Remove <em>global recipe</em>
            </h3>
          </div>
          <form action={removeFeatureAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="hidden" name="projectSlug" value="__global__" />
            <input type="hidden" name="fslug" value={recipe.slug} />
            <p style={hintStyle}>
              Type <code style={mono}>remove {recipe.slug}</code> to delete this global recipe.
            </p>
            <input name="confirmation" style={textInputStyle} />
            <button type="submit" className="btn btn--ghost" style={{ alignSelf: 'flex-start' }}>
              Remove recipe
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

function Field({
  label,
  name,
  defaultValue,
  required,
  multiline,
}: {
  label: string;
  name: string;
  defaultValue: string;
  required?: boolean;
  multiline?: boolean;
}) {
  const id = `edit-feature-${name}`;
  return (
    <div className="field">
      <label htmlFor={id} style={fieldLabelStyle}>
        {label}
      </label>
      {multiline === true ? (
        <textarea
          id={id}
          name={name}
          rows={3}
          defaultValue={defaultValue}
          {...(required === true ? { required: true } : {})}
          style={textareaStyle}
        />
      ) : (
        <input
          id={id}
          name={name}
          defaultValue={defaultValue}
          {...(required === true ? { required: true } : {})}
          style={textInputStyle}
        />
      )}
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
  marginTop: 0,
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

const mono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};
