import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { saveFeaturePackAction } from '@/lib/actions/packs';
import { parseAutoSections, summarizeParseErrors } from '@/lib/feature-pack-markers';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]/edit` — section-aware feature pack
 * editor (M04 Phase 2 S6).
 *
 * One file at a time (controlled by `?file=spec.md|implementation.md|
 * techstack.md`). The page renders a textarea pre-filled with the on-
 * disk content + a sidebar listing the auto-marker sections that the
 * file currently has.
 *
 * Marker contract (enforced by `saveFeaturePackAction`):
 *   - Inner content of any `<!-- @auto:NAME -->...<!-- /@auto -->`
 *     section is freely editable.
 *   - The marker SET (names + order) must be unchanged. Adding,
 *     removing, renaming, or reordering markers is the responsibility
 *     of `pack regenerate` (S5) or `install template` (S5) — those
 *     surfaces are how the operator legitimately changes a pack's
 *     marker shape.
 *   - Optimistic concurrency: the form carries the file's mtime as a
 *     hidden input. If anyone else writes the file in the meantime,
 *     the save is refused with a "concurrent_edit" banner.
 *
 * Why server-rendered without a client editor: zero JS keeps the page
 * ironclad in solo mode and matches the rest of the dashboard's no-JS
 * default. A future slice can layer a client-side preview on top
 * without changing the data contract.
 */

export const dynamic = 'force-dynamic';

const EDITABLE_FILES = ['spec.md', 'implementation.md', 'techstack.md'] as const;
type EditableFile = (typeof EDITABLE_FILES)[number];

interface SearchParams {
  readonly file?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function EditPackPage({
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
  if (pack.slug !== project.slug && pack.parentSlug !== project.slug) notFound();

  const sp = await searchParams;
  const requested = sp.file;
  const file: EditableFile =
    typeof requested === 'string' && (EDITABLE_FILES as ReadonlyArray<string>).includes(requested)
      ? (requested as EditableFile)
      : 'spec.md';

  // Bounce to the safe default if the file was specified but invalid.
  if (typeof requested === 'string' && !(EDITABLE_FILES as ReadonlyArray<string>).includes(requested)) {
    redirect(`/projects/${encodeURIComponent(project.slug)}/packs/${encodeURIComponent(pack.slug)}/edit?file=spec.md`);
  }

  const cwd = dirname(dirname(pack.dir));
  const filePath = join(pack.dir, file);
  const body = file === 'spec.md' ? pack.spec : file === 'implementation.md' ? pack.implementation : pack.techstack;
  let mtimeMs = 0;
  try {
    mtimeMs = Math.floor(statSync(filePath).mtimeMs);
  } catch {
    // File missing — render an empty editor and let the save action
    // surface the error. The user can still see the marker hints once
    // they paste content in.
  }
  const fileExists = body !== null;
  const safeBody = body ?? '';
  const parse = parseAutoSections(safeBody);
  const projectHref = `/projects/${encodeURIComponent(project.slug)}/packs/${encodeURIComponent(pack.slug)}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            Edit{' '}
            <span className="font-mono text-2xl normal-case tracking-normal text-(--color-text-code)">{pack.slug}</span>
          </h1>
          <Link
            href={projectHref as never}
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
          >
            ◂ Back to pack
          </Link>
        </div>
        <p className="text-sm text-(--color-text-secondary)">
          Section-aware editor. Inner content of every <span className="font-mono">&lt;!-- @auto:NAME --&gt;</span>{' '}
          section is editable; the marker set itself is locked. Use <span className="font-mono">Regenerate</span> or{' '}
          <span className="font-mono">Install template</span> to add or remove sections.
        </p>
      </header>

      <FileTabs projectSlug={project.slug} packSlug={pack.slug} active={file} />

      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-2 text-sm">
          ✕ <span className="font-mono">{sp.error}</span>
          {sp.errorMessage !== undefined ? <span className="ml-2">{sp.errorMessage}</span> : null}
        </div>
      ) : null}

      {!fileExists ? (
        <div className="border-l-4 border-(--color-status-warning) bg-(--color-status-warning)/10 px-4 py-2 text-sm">
          ⚠ <span className="font-mono">{file}</span> does not exist on disk yet. Saving will create it. New auto
          markers must be added via <span className="font-mono">Regenerate</span> first.
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <form action={saveFeaturePackAction} className="flex flex-col gap-3">
          <input type="hidden" name="projectSlug" value={project.slug} />
          <input type="hidden" name="packSlug" value={pack.slug} />
          <input type="hidden" name="cwd" value={cwd} />
          <input type="hidden" name="fileName" value={file} />
          <input type="hidden" name="mtimeMs" value={mtimeMs} />

          <label className="flex flex-col gap-1">
            <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
              {file}
            </span>
            <textarea
              name="content"
              defaultValue={safeBody}
              spellCheck={false}
              className="h-[60vh] w-full resize-y border border-(--color-border-default) bg-(--color-bg-base) p-3 font-mono text-sm text-(--color-text-primary)"
            />
          </label>
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-(--color-text-tertiary)">
              File mtime: <span className="font-mono">{mtimeMs}</span> · Marker contract enforced server-side.
            </p>
            <button
              type="submit"
              className="bg-(--color-brand) px-6 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
            >
              Save
            </button>
          </div>
        </form>

        <aside className="flex flex-col gap-4">
          <SectionList sections={parse.sections} errors={parse.errors} />
          <MarkerHelp />
        </aside>
      </div>
    </div>
  );
}

function FileTabs({
  projectSlug,
  packSlug,
  active,
}: {
  readonly projectSlug: string;
  readonly packSlug: string;
  readonly active: EditableFile;
}) {
  return (
    <nav className="flex border-b border-(--color-border-subtle)">
      {EDITABLE_FILES.map((f) => (
        <Link
          key={f}
          href={
            `/projects/${encodeURIComponent(projectSlug)}/packs/${encodeURIComponent(packSlug)}/edit?file=${f}` as never
          }
          className={`-mb-px border-b-2 px-4 py-2 font-mono text-sm ${
            f === active
              ? 'border-(--color-brand) text-(--color-brand)'
              : 'border-transparent text-(--color-text-secondary) hover:text-(--color-text-primary)'
          }`}
        >
          {f}
        </Link>
      ))}
    </nav>
  );
}

function SectionList({
  sections,
  errors,
}: {
  readonly sections: ReturnType<typeof parseAutoSections>['sections'];
  readonly errors: ReturnType<typeof parseAutoSections>['errors'];
}) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
      <h2 className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        Auto-marker sections
      </h2>
      {errors.length > 0 ? (
        <p className="mt-2 text-xs text-(--color-status-error)">⚠ Parse errors: {summarizeParseErrors(errors)}</p>
      ) : null}
      {sections.length === 0 ? (
        <p className="mt-2 text-xs text-(--color-text-tertiary)">No auto markers in this file.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {sections.map((s) => (
            <li key={s.name} className="flex items-baseline gap-2 font-mono">
              <span className="text-(--color-text-secondary)">L{s.openLine}</span>
              <span className="text-(--color-text-primary)">{s.name}</span>
              <span className="text-(--color-text-tertiary)">
                ({s.innerLines.length} {s.innerLines.length === 1 ? 'line' : 'lines'})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MarkerHelp() {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
      <h2 className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        Editing rules
      </h2>
      <ul className="mt-2 flex flex-col gap-1 text-xs text-(--color-text-tertiary)">
        <li>
          ✓ Edit text inside <span className="font-mono">@auto:NAME</span> sections freely.
        </li>
        <li>✓ Edit text outside any auto section freely.</li>
        <li>
          ✕ Don't add or remove <span className="font-mono">&lt;!-- @auto:* --&gt;</span> markers — use Regenerate /
          Install instead.
        </li>
        <li>✕ Don't reorder existing sections — same.</li>
        <li>
          ⚠ If the file changed on disk since this page loaded, the save is refused with a "concurrent edit" banner.
        </li>
      </ul>
    </div>
  );
}
