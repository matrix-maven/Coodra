import { dirname } from 'node:path';

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { StatusChip } from '@/components/StatusChip';
import { deletePackAction, installTemplateAction, regeneratePackAction } from '@/lib/actions/packs';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]` — server-rendered pack detail.
 *
 * S4: markdown renderer for spec.md / implementation.md / techstack.md.
 * S5: action bar (Regenerate / Delete / Install template) wired to
 *     the Server Actions in `apps/web/lib/actions/packs.ts`.
 *
 * Per OQ-7 lock (S5 default): Delete matches the real CLI semantics —
 * `rm(dir, recursive)` + `feature_packs.is_active = false`. Both
 * happen on confirmed delete. Re-lock checkpoint passed.
 *
 * Force-dynamic so newly-edited files appear without a rebuild.
 */
export const dynamic = 'force-dynamic';

const BUNDLED_TEMPLATES = [
  'generic',
  'nextjs-saas',
  'node-monorepo',
  'python-fastapi',
  'python-ml',
  'rust-cli',
  'go-service',
] as const;

interface SearchParams {
  readonly regenerated?: string;
  readonly deleted?: string;
  readonly installed?: string;
  readonly edited?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; packSlug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const { packSlug: rawPackSlug } = await params;
  const packSlug = decodeURIComponent(rawPackSlug);
  const pack = getPack(packSlug);
  if (pack === null) notFound();
  // Project ownership check: pack must be slug-owned or parent-owned by this project.
  if (pack.slug !== project.slug && pack.parentSlug !== project.slug) notFound();
  const sp = await searchParams;
  // Resolve cwd from pack.dir: pack.dir = `<cwd>/docs/feature-packs/<slug>`,
  // so cwd is two levels up. Server Actions need the absolute cwd to
  // pass through to runPackRegenerate / runPackDelete.
  const cwd = dirname(dirname(pack.dir));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1 className="font-mono text-3xl font-medium text-(--color-text-primary)">{pack.slug}</h1>
            <StatusChip status={pack.isActive ? 'success' : 'neutral'}>
              {pack.isActive ? 'active' : 'inactive'}
            </StatusChip>
          </div>
          <ActionBar projectSlug={project.slug} packSlug={pack.slug} cwd={cwd} />
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          <Field label="Directory" value={<span className="font-mono text-xs">{pack.dir}</span>} />
          <Field label="Parent" value={<span className="font-mono">{pack.parentSlug ?? '—'}</span>} />
          <Field
            label="Files"
            value={
              <span className="font-mono">
                {pack.fileCount}/4
                {pack.fileCount < 4 ? <span className="ml-1 text-(--color-status-warning)">⚠</span> : null}
              </span>
            }
          />
        </dl>
        <Banners {...sp} packSlug={pack.slug} />
      </header>

      <Section title="spec.md">
        <MarkdownBody body={pack.spec} />
      </Section>

      <Section title="implementation.md">
        <MarkdownBody body={pack.implementation} />
      </Section>

      <Section title="techstack.md">
        <MarkdownBody body={pack.techstack} />
      </Section>

      <Section title="meta.json">
        {/* meta.json stays as-is — it's structured JSON, not markdown. */}
        <FileBody body={pack.metaRaw} mono />
      </Section>

      <div>
        <Link
          href={`/projects/${encodeURIComponent(project.slug)}/packs` as never}
          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
        >
          ◂ Back to packs
        </Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function FileBody({ body, mono }: { readonly body: string | null; readonly mono?: boolean }) {
  if (body === null) {
    return (
      <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-tertiary)">
        File not present.
      </div>
    );
  }
  return (
    <pre
      className={
        mono === true
          ? 'overflow-x-auto whitespace-pre border border-(--color-border-subtle) bg-(--color-bg-surface) p-4 font-mono text-xs text-(--color-text-primary)'
          : 'overflow-x-auto whitespace-pre-wrap border border-(--color-border-subtle) bg-(--color-bg-surface) p-4 font-mono text-xs text-(--color-text-primary)'
      }
    >
      {body}
    </pre>
  );
}

/**
 * Markdown wrapper used for spec.md / implementation.md / techstack.md.
 * Renders the body via the brand-styled MarkdownRenderer. Empty/missing
 * files fall through to the plain "File not present." card.
 */
function MarkdownBody({ body }: { readonly body: string | null }) {
  if (body === null) {
    return (
      <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-tertiary)">
        File not present.
      </div>
    );
  }
  return (
    <article className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <MarkdownRenderer body={body} />
    </article>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}:
      </dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Action bar (S5)
// ---------------------------------------------------------------------------

function ActionBar({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={
          `/projects/${encodeURIComponent(projectSlug)}/packs/${encodeURIComponent(packSlug)}/edit?file=spec.md` as never
        }
        className="border border-(--color-border-default) bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
      >
        Edit
      </Link>
      <Link
        href={`/projects/${encodeURIComponent(projectSlug)}/packs/${encodeURIComponent(packSlug)}/runs` as never}
        className="border border-(--color-border-default) bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
      >
        Activity
      </Link>
      <RegenerateButton projectSlug={projectSlug} packSlug={packSlug} cwd={cwd} />
      <InstallTemplateButton projectSlug={projectSlug} packSlug={packSlug} cwd={cwd} />
      <DeleteButton projectSlug={projectSlug} packSlug={packSlug} cwd={cwd} />
    </div>
  );
}

function RegenerateButton({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none border border-(--color-border-default) bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)">
        Regenerate ▾
      </summary>
      <form
        action={regeneratePackAction}
        className="absolute right-0 z-10 mt-1 flex w-80 flex-col gap-3 border border-(--color-border-default) bg-(--color-bg-surface) p-4 shadow-md"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-(--color-text-secondary)">
          Re-renders auto-managed sections from the template. User-edited content outside auto-marker blocks is
          preserved.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" value="yes" required />
          <span>Yes, regenerate this pack</span>
        </label>
        <button
          type="submit"
          className="bg-(--color-brand) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
        >
          Regenerate
        </button>
      </form>
    </details>
  );
}

function InstallTemplateButton({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none border border-(--color-border-default) bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)">
        Install template ▾
      </summary>
      <form
        action={installTemplateAction}
        className="absolute right-0 z-10 mt-1 flex w-96 flex-col gap-3 border border-(--color-border-default) bg-(--color-bg-surface) p-4 shadow-md"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-(--color-text-secondary)">
          Overlays a bundled template onto this pack. Auto-managed sections are replaced; unmanaged user content is
          preserved by the seed merger.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
            Template
          </span>
          <select
            name="templateName"
            required
            defaultValue="generic"
            className="border border-(--color-border-default) bg-(--color-bg-base) px-2 py-1.5 font-mono text-sm"
          >
            {BUNDLED_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
            Type <span className="font-mono normal-case tracking-normal">install &lt;template&gt;</span> to confirm
          </span>
          <input
            type="text"
            name="confirmation"
            required
            placeholder="install <template-name>"
            autoComplete="off"
            className="border border-(--color-border-default) bg-(--color-bg-base) px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          className="bg-(--color-brand) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
        >
          Install
        </button>
      </form>
    </details>
  );
}

function DeleteButton({
  projectSlug,
  packSlug,
  cwd,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly cwd: string;
}) {
  return (
    <details className="group relative">
      <summary className="cursor-pointer list-none border border-(--color-status-error)/40 bg-(--color-bg-base) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-status-error) hover:bg-(--color-status-error)/10">
        Delete ▾
      </summary>
      <form
        action={deletePackAction}
        className="absolute right-0 z-10 mt-1 flex w-96 flex-col gap-3 border border-(--color-status-error)/40 bg-(--color-bg-surface) p-4 shadow-md"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="packSlug" value={packSlug} />
        <input type="hidden" name="cwd" value={cwd} />
        <p className="text-xs text-(--color-text-primary)">
          Per CLI semantics: removes <span className="font-mono">{`docs/feature-packs/${packSlug}/`}</span> from disk
          AND flips <span className="font-mono">feature_packs.is_active = false</span>. Row preserved per ADR-007.
        </p>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
            Type <span className="font-mono normal-case tracking-normal">delete {packSlug}</span> to confirm
          </span>
          <input
            type="text"
            name="confirmation"
            required
            placeholder={`delete ${packSlug}`}
            autoComplete="off"
            className="border border-(--color-border-default) bg-(--color-bg-base) px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          className="bg-(--color-status-error) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:opacity-80"
        >
          Delete
        </button>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

function Banners(sp: SearchParams & { readonly packSlug: string }) {
  return (
    <div className="flex flex-col gap-2">
      {sp.regenerated !== undefined ? (
        <Banner kind="success">✓ Regenerated. Auto-managed sections refreshed.</Banner>
      ) : null}
      {sp.installed !== undefined ? (
        <Banner kind="success">
          ✓ Installed template <span className="font-mono">{sp.installed}</span>.
        </Banner>
      ) : null}
      {sp.edited !== undefined ? (
        <Banner kind="success">
          ✓ Saved <span className="font-mono">{sp.edited}</span>. Auto-marker contract preserved.
        </Banner>
      ) : null}
      {sp.deleted !== undefined ? (
        // Reachable only via direct URL fiddling (the action redirects
        // to /packs after a successful delete, where this banner
        // doesn't render). Kept defensive.
        <Banner kind="info">
          Pack <span className="font-mono">{sp.deleted}</span> deleted.
        </Banner>
      ) : null}
      {sp.error !== undefined ? (
        <Banner kind="error">
          ✕ {sp.error}
          {sp.errorMessage !== undefined ? <span className="ml-2">{sp.errorMessage}</span> : null}
        </Banner>
      ) : null}
    </div>
  );
}

function Banner({
  kind,
  children,
}: {
  readonly kind: 'success' | 'info' | 'error';
  readonly children: React.ReactNode;
}) {
  const colors: Record<'success' | 'info' | 'error', string> = {
    success: 'border-(--color-status-success) bg-(--color-status-success)/10',
    info: 'border-(--color-status-info) bg-(--color-status-info)/10',
    error: 'border-(--color-status-error) bg-(--color-status-error)/10',
  };
  return <div className={`border-l-4 ${colors[kind]} px-4 py-2 text-sm`}>{children}</div>;
}
