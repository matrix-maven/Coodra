import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { uploadPackAction } from '@/lib/actions/packs';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listPacks, packsRoot } from '@/lib/queries/packs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly error?: string;
  readonly errorMessage?: string;
}

/**
 * /projects/[slug]/packs/new — per-project freeform feature-pack
 * upload (skill-style + linked-as-parent flow).
 *
 * Counterpart to the global `/packs/new`. Differences:
 *   - The slug field defaults to the project's own slug, so
 *     submitting unchanged replaces the project's primary pack (the
 *     one the bridge auto-injects on SessionStart, see
 *     apps/hooks-bridge/src/lib/feature-pack-loader.ts:72-74).
 *   - When the operator changes the slug, the "auto-link as parent"
 *     checkbox (default ON) instructs the action to patch
 *     <projectSlug>/meta.json:parentSlug = <upload-slug>, so the
 *     uploaded pack is loaded as an ancestor by the MCP-side
 *     walkAncestors at apps/mcp-server/src/lib/feature-pack.ts:330-357.
 *   - Pre-flight refusal if auto-link is ON but the project's
 *     primary pack doesn't yet exist on disk — keeps the filesystem
 *     consistent.
 *
 * The upload itself goes through the shared `uploadPackAction` which
 * also serves the global form; the project-context branch is keyed
 * off the hidden `projectSlug` form field.
 */
export default async function NewProjectPackPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  // Anchor every pack read on `projects.cwd` (the absolute project root
  // recorded by the bridge / CLI). When null (legacy row), fall back to
  // web-v2's process.cwd() — the upload action will inherit the same fallback,
  // so reads and writes stay in sync. The page surfaces a warning when the
  // cwd is unrecorded (`cwdRecorded === false`).
  const projectCwd = project.cwd ?? process.cwd();
  const cwdRecorded = project.cwd !== null;
  const root = packsRoot(projectCwd);
  const allPacks = await listPacks(projectCwd);
  const existing = allPacks.map((p) => p.slug);
  const primaryRow = allPacks.find((p) => p.slug === project.slug);
  const primaryExists = primaryRow !== undefined;
  // A stub doesn't count as a "real" primary for the purposes of
  // auto-linking — the upload form should treat replacing-a-stub the
  // same as creating-from-scratch (no force-overwrite ceremony, no
  // "auto-link as parent" implication). A real, hand-written primary
  // is the only thing that makes "auto-link as parent" meaningful.
  const primaryIsStub = primaryRow?.isTemplateStub === true;

  return (
    <>
      <Topbar crumb={`${project.slug} / new pack`} crumbPrefix="coodra / projects" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()} · NEW PACK</div>
            <h1 className="head__title">
              Attach a <em>reference</em> to {project.slug}.
            </h1>
            <p className="head__lede">
              Upload a markdown file (or paste). Keep the slug as <code style={mono}>{project.slug}</code> to replace
              the project&apos;s primary pack — the one the bridge auto-injects on SessionStart. Change it to a custom
              slug to add a linked reference; the action will wire it as the parent of{' '}
              <code style={mono}>{project.slug}</code> automatically.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {primaryExists ? (primaryIsStub ? 'primary is a template stub' : 'primary present') : 'no primary yet'}
              </strong>
              <br />
              {root}/{project.slug}/
              <br />
              {allPacks.length} packs in workspace
            </div>
            <div className="head__actions">
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}`}>
                ← back to {project.slug}
              </Link>
              <Link className="btn btn--ghost" href="/templates">
                Use a template
              </Link>
            </div>
          </div>
        </div>

        {sp.error !== undefined ? <div className="banner banner--warn">{sp.errorMessage ?? sp.error}</div> : null}

        {!cwdRecorded ? (
          <div className="banner banner--warn">
            This project has no recorded <code style={mono}>cwd</code>. Uploads will land under the web server&apos;s
            working directory (<code style={mono}>{projectCwd}</code>), which may not be the project&apos;s real folder.
            Open a Claude Code session inside the project root once so the bridge can record it, or re-run{' '}
            <code style={mono}>coodra init</code>.
          </div>
        ) : null}

        {primaryIsStub ? (
          <div className="banner">
            The primary pack is a <code style={mono}>coodra init</code> template stub. Uploading with the default
            slug below will silently replace it (no force-overwrite needed) — the action treats stubs as the
            obvious replace-target. Auto-link is treated as off when replacing a stub.
          </div>
        ) : null}

        {!primaryExists ? (
          <div className="banner">
            No primary pack yet for <code style={mono}>{project.slug}</code>. Submit with the default slug to create it,
            or visit{' '}
            <Link href="/init" style={{ textDecoration: 'underline' }}>
              /init
            </Link>{' '}
            to bootstrap from a template. Auto-link is disabled until a primary exists.
          </div>
        ) : null}

        <div className="card" style={{ padding: 32 }}>
          <div className="card__head" style={{ marginBottom: 24 }}>
            <h2 className="card__title">
              Upload <em>markdown</em>
            </h2>
            <span className="card__role">project · {project.slug} · file or paste</span>
          </div>

          {/* Server Actions set encType automatically; specifying it here would
              be overridden + warns at runtime in Next 15. File upload still
              works — React encodes multipart when an <input type="file"> is
              present in the form. */}
          <form action={uploadPackAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Project context — drives error/success redirect targets and the auto-link branch. */}
            <input type="hidden" name="projectSlug" value={project.slug} />
            {/* Project root cwd from `projects.cwd`. Pin the upload destination to
                the project's own filesystem root so packs land in
                `<project.cwd>/docs/feature-packs/<slug>/`, not the web-v2 server
                cwd. Falls back to web-v2's process.cwd() when the column is
                null (legacy rows) — same fallback the read-side already uses,
                so the panel and the write target agree. */}
            <input type="hidden" name="projectCwd" value={projectCwd} />

            <Field
              label="Slug"
              name="slug"
              defaultValue={project.slug}
              placeholder={project.slug}
              required
              hint={`Defaults to "${project.slug}". Keep it as-is to replace the primary pack; change it to add a linked reference.`}
            />

            <Field
              label="Manual parentSlug (optional)"
              name="parentSlug"
              placeholder="e.g. typescript"
              hint="Set this only if you want THIS upload itself to inherit from another pack. Leave blank for a top-level reference."
            />

            <div className="field">
              <label htmlFor="upload-file" style={fieldLabelStyle}>
                Markdown file
              </label>
              <input
                id="upload-file"
                type="file"
                name="file"
                accept=".md,.markdown,text/markdown,text/plain"
                style={fileInputStyle}
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
              <label htmlFor="upload-content" style={fieldLabelStyle}>
                Markdown body
              </label>
              <textarea
                id="upload-content"
                name="content"
                placeholder={`# ${project.slug}\n\nA reference document the agent will load as context for this project.\n\n## Section\n\n- bullet\n- bullet`}
                rows={14}
                style={textareaStyle}
              />
              <p style={hintStyle}>
                Goes to <code style={mono}>{root}/&lt;slug&gt;/spec.md</code>. A minimal{' '}
                <code style={mono}>meta.json</code> with <code style={mono}>{'{ kind: "freeform" }'}</code> is written
                alongside.
              </p>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--ink-dim)',
                letterSpacing: '0.04em',
                lineHeight: 1.6,
              }}
            >
              <input
                type="checkbox"
                name="linkAsParent"
                defaultChecked={primaryExists && !primaryIsStub}
                disabled={!primaryExists || primaryIsStub}
                style={{ marginTop: 2 }}
              />
              <span>
                Auto-link as <em>parent</em> of <code style={mono}>{project.slug}</code>. The agent loads this
                pack&apos;s body before the primary&apos;s on next <code style={mono}>get_feature_pack</code>. Ignored
                when the slug equals the project&apos;s slug.
                {!primaryExists ? (
                  <>
                    <br />
                    <span style={{ color: 'var(--warn)' }}>
                      Disabled — no primary pack on disk to link onto. Submit unchanged first.
                    </span>
                  </>
                ) : null}
              </span>
            </label>

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
              <Link href={`/projects/${encodeURIComponent(project.slug)}`} className="btn btn--ghost">
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
  defaultValue,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  defaultValue?: string;
}) {
  const inputId = `field-${name}`;
  return (
    <div className="field">
      <label htmlFor={inputId} style={fieldLabelStyle}>
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(required === true ? { required: true } : {})}
        {...(defaultValue !== undefined ? { defaultValue } : {})}
        style={textInputStyle}
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

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
};

const textareaStyle: React.CSSProperties = {
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
