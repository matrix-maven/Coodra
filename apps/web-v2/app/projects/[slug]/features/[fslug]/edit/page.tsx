import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { editFeatureMetaAction, removeFeatureAction, uploadFeatureFileAction } from '@/lib/actions/features';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchFeatureDetail } from '@/lib/queries/features';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function EditFeaturePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; fslug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const { fslug: encFslug } = await params;
  const fslug = decodeURIComponent(encFslug);
  const sp = await searchParams;
  const projectCwd = project.cwd ?? process.cwd();
  const row = fetchFeatureDetail({ projectCwd, slug: fslug });
  if (row === null) notFound();

  const fm = row.frontmatter;
  const featureUrl = `/projects/${encodeURIComponent(project.slug)}/features/${encodeURIComponent(row.slug)}`;

  return (
    <>
      <Topbar
        crumb={`${project.slug} / features / ${row.slug} / edit`}
        crumbPrefix="contextos / projects"
      />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · FEATURE · EDIT</div>
            <h1 className="head__title">
              Edit <em>{row.slug}</em>
            </h1>
            <p className="head__lede">
              Edit the trigger description, body, or maturity. Save to overwrite{' '}
              <code style={mono}>feature.md</code> on disk; the index regenerates automatically.
            </p>
          </div>
          <div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={featureUrl}>
                ← back to {row.slug}
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

        <div className="card" style={{ padding: 32, marginBottom: 24 }}>
          <div className="card__head" style={{ marginBottom: 18 }}>
            <h2 className="card__title">
              Metadata <em>+</em> body
            </h2>
            <span className="card__role">writes feature.md</span>
          </div>
          <form action={editFeatureMetaAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input type="hidden" name="fslug" value={row.slug} />

            <div className="field">
              <label style={labelStyle} htmlFor="edit-feature-description">
                Description (the agent's trigger)
              </label>
              <textarea
                id="edit-feature-description"
                name="description"
                rows={3}
                required
                defaultValue={fm.description}
                style={textareaStyle}
              />
            </div>

            <div className="field">
              <label style={labelStyle} htmlFor="edit-feature-when-not">
                When NOT to use (optional)
              </label>
              <textarea
                id="edit-feature-when-not"
                name="whenNotToUse"
                rows={2}
                defaultValue={fm.whenNotToUse ?? ''}
                style={textareaStyle}
              />
            </div>

            <div className="field">
              <label style={labelStyle} htmlFor="edit-feature-maturity">
                Maturity
              </label>
              <select
                id="edit-feature-maturity"
                name="maturity"
                defaultValue={fm.maturity ?? 'draft'}
                style={{
                  ...textInputStyle,
                  // Reuse text input width but keep select control look.
                }}
              >
                <option value="draft">draft</option>
                <option value="beta">beta</option>
                <option value="stable">stable</option>
                <option value="deprecated">deprecated</option>
              </select>
            </div>

            <div className="field">
              <label style={labelStyle} htmlFor="edit-feature-body">
                Body
              </label>
              <textarea
                id="edit-feature-body"
                name="body"
                rows={20}
                defaultValue={row.body}
                style={textareaStyle}
              />
              <p style={hintStyle}>
                Free-form markdown. Loaded by <code style={mono}>contextos__get_feature</code>. The frontmatter is
                emitted deterministically by the server action — your edits round-trip without diff noise.
              </p>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" className="btn btn--accent">
                Save
              </button>
              <Link href={featureUrl} className="btn btn--ghost">
                Cancel
              </Link>
            </div>
          </form>
        </div>

        <div className="card" style={{ padding: 28, marginBottom: 24 }}>
          <div className="card__head" style={{ marginBottom: 12 }}>
            <h2 className="card__title">
              Upload supporting <em>file</em>
            </h2>
            <span className="card__role">drops one file into {row.dir}</span>
          </div>
          <form action={uploadFeatureFileAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input type="hidden" name="fslug" value={row.slug} />
            <input
              type="file"
              name="file"
              required
              accept=".md,.markdown,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.sql,.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.rs,.go,.java,.rb,.sh,.bash,.zsh,.html,.css,.xml"
              style={fileInputStyle}
            />
            <button type="submit" className="btn">
              Upload
            </button>
          </form>
        </div>

        <div
          className="card"
          style={{
            padding: 28,
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
          }}
        >
          <div className="card__head" style={{ marginBottom: 12 }}>
            <h2 className="card__title" style={{ color: 'var(--warn)' }}>
              Remove <em>feature</em>
            </h2>
            <span className="card__role">irreversible · deletes the directory</span>
          </div>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--warn)', marginBottom: 12 }}>
            Deletes <code style={mono}>{row.dir}</code> from disk and regenerates the index. Re-creatable via the
            create form.
          </p>
          <form action={removeFeatureAction} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <input type="hidden" name="projectSlug" value={project.slug} />
            <input type="hidden" name="fslug" value={row.slug} />
            <input
              name="confirmation"
              required
              placeholder={`Type "remove ${row.slug}" to confirm`}
              style={textInputStyle}
            />
            <button
              type="submit"
              className="btn btn--sm"
              style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
            >
              Remove feature
            </button>
          </form>
        </div>
      </section>
    </>
  );
}

const labelStyle: React.CSSProperties = {
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
