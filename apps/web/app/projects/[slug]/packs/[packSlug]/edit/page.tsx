import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import {
  AlertTriangleIcon,
  Banner,
  Breadcrumbs,
  Button,
  Card,
  type Crumb,
  PageHeader,
  PageShell,
  Section,
  Textarea,
} from '@/components/ui';
import { saveFeaturePackAction } from '@/lib/actions/packs';
import { parseAutoSections, summarizeParseErrors } from '@/lib/feature-pack-markers';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]/edit` — section-aware feature
 * pack editor (M04 Phase 2 S6, restyled in Phase 2 UI).
 *
 * Server-rendered; one file per page-load (controlled by ?file=).
 * Marker contract enforced by saveFeaturePackAction:
 *   - Inner content of each <!-- @auto:NAME --> section is editable.
 *   - The marker SET (names + order) is locked.
 *   - mtime-based optimistic concurrency check.
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
    // File missing — render empty editor; save action surfaces the error.
  }
  const fileExists = body !== null;
  const safeBody = body ?? '';
  const parse = parseAutoSections(safeBody);

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const packHref = `${baseHref}/packs/${encodeURIComponent(pack.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Packs', href: `${baseHref}/packs` },
    { label: pack.slug, href: packHref, mono: true },
    { label: 'Edit' },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Pack · editor"
        title="Edit"
        code={pack.slug}
        subtitle={
          <>
            Section-aware editor. Inner content of every <span className="font-mono">&lt;!-- @auto:NAME --&gt;</span>{' '}
            section is editable; the marker set itself is locked. Use <span className="font-mono">Regenerate</span> or{' '}
            <span className="font-mono">Install template</span> to add or remove sections.
          </>
        }
      />

      <FileTabs projectSlug={project.slug} packSlug={pack.slug} active={file} />

      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          {sp.errorMessage ?? '—'}
        </Banner>
      ) : null}

      {!fileExists ? (
        <Banner kind="warning">
          <span className="font-mono">{file}</span> does not exist on disk yet. Saving will create it. New auto markers
          must be added via <span className="font-mono">Regenerate</span> first.
        </Banner>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <form action={saveFeaturePackAction} className="flex flex-col gap-3">
          <input type="hidden" name="projectSlug" value={project.slug} />
          <input type="hidden" name="packSlug" value={pack.slug} />
          <input type="hidden" name="cwd" value={cwd} />
          <input type="hidden" name="fileName" value={file} />
          <input type="hidden" name="mtimeMs" value={mtimeMs} />

          <label htmlFor={`edit-content-${file}`} className="text-xs font-medium text-text-secondary">
            {file}
          </label>
          <Textarea
            id={`edit-content-${file}`}
            name="content"
            defaultValue={safeBody}
            spellCheck={false}
            mono
            className="h-[60vh]"
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-text-tertiary">
              File mtime: <span className="font-mono">{mtimeMs}</span> · Marker contract enforced server-side.
            </p>
            <Button type="submit" variant="primary">
              Save changes
            </Button>
          </div>
        </form>

        <aside className="flex flex-col gap-(--space-stack)">
          <Section title="Auto-marker sections">
            <Card size="sm">
              {parse.errors.length > 0 ? (
                <p className="flex items-start gap-2 text-xs text-status-error">
                  <AlertTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Parse errors: {summarizeParseErrors(parse.errors)}</span>
                </p>
              ) : null}
              {parse.sections.length === 0 ? (
                <p className="text-xs text-text-tertiary">No auto markers in this file.</p>
              ) : (
                <ul className="flex flex-col gap-1.5 text-xs">
                  {parse.sections.map((s) => (
                    <li key={s.name} className="flex items-baseline gap-2 font-mono">
                      <span className="text-text-tertiary">L{s.openLine}</span>
                      <span className="text-text-primary">{s.name}</span>
                      <span className="text-text-tertiary">
                        ({s.innerLines.length} {s.innerLines.length === 1 ? 'line' : 'lines'})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section title="Editing rules">
            <Card size="sm">
              <ul className="flex flex-col gap-1 text-xs text-text-secondary">
                <li>
                  Edit text inside <span className="font-mono">@auto:NAME</span> sections freely.
                </li>
                <li>Edit text outside any auto section freely.</li>
                <li>
                  Don't add or remove <span className="font-mono">&lt;!-- @auto:* --&gt;</span> markers — use Regenerate
                  or Install instead.
                </li>
                <li>Don't reorder existing sections.</li>
                <li>If the file changed on disk since this page loaded, save is refused with concurrent-edit.</li>
              </ul>
            </Card>
          </Section>
        </aside>
      </div>
    </PageShell>
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
    <nav aria-label="File" className="flex border-b border-border-subtle">
      {EDITABLE_FILES.map((f) => (
        <Link
          key={f}
          href={
            `/projects/${encodeURIComponent(projectSlug)}/packs/${encodeURIComponent(packSlug)}/edit?file=${f}` as never
          }
          aria-current={f === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-4 py-2 font-mono text-sm transition-colors duration-200 ${
            f === active ? 'border-brand text-brand' : 'border-transparent text-text-secondary hover:text-text-primary'
          }`}
        >
          {f}
        </Link>
      ))}
    </nav>
  );
}
