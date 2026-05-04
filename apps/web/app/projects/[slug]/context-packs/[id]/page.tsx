import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getContextPack } from '@/lib/queries/context-packs';

/**
 * `/projects/[slug]/context-packs/[id]` — Context Pack detail (M04
 * Phase 2 S9).
 *
 * Server-rendered. Reads the full body via `getContextPack` and
 * renders it through the S4 markdown renderer (XSS-safe via
 * rehype-sanitize). Project-ownership check on the row's projectId
 * matches the URL slug — a deep link to a CP that belongs to a
 * different project resolves to 404.
 *
 * Sidebar: row metadata (id, run id, created_at) + back link to the
 * project's CP list.
 */

export const dynamic = 'force-dynamic';

export default async function ContextPackDetailPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const pack = await getContextPack(id);
  if (pack === null) notFound();
  // Project ownership check: a deep link from a different project's
  // listing shouldn't render someone else's CP.
  if (pack.projectId !== project.id) notFound();

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-display text-3xl font-black uppercase tracking-wide text-(--color-text-primary)">
            {pack.title}
          </h1>
          <Link
            href={`${baseHref}/context-packs` as never}
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary) hover:text-(--color-brand)"
          >
            ◂ Back to context packs
          </Link>
        </div>
        <p className="text-sm text-(--color-text-secondary)">
          Saved <span className="font-mono">{formatDate(pack.createdAt)}</span> from run{' '}
          <Link
            href={`${baseHref}/runs/${encodeURIComponent(pack.runId)}` as never}
            className="font-mono text-(--color-brand) hover:underline"
          >
            {pack.runId}
          </Link>
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <article className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
          <MarkdownRenderer body={pack.content} />
        </article>

        <aside className="flex flex-col gap-4">
          <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
            <h2 className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
              Metadata
            </h2>
            <dl className="mt-2 flex flex-col gap-2 text-xs">
              <Field label="Pack id" value={<span className="font-mono">{pack.id}</span>} />
              <Field
                label="Run id"
                value={
                  <Link
                    href={`${baseHref}/runs/${encodeURIComponent(pack.runId)}` as never}
                    className="font-mono text-(--color-brand) hover:underline"
                  >
                    {pack.runId}
                  </Link>
                }
              />
              <Field label="Project id" value={<span className="font-mono">{pack.projectId}</span>} />
              <Field label="Created" value={<span className="font-mono">{formatDate(pack.createdAt)}</span>} />
              <Field
                label="Excerpt length"
                value={<span className="font-mono">{pack.contentExcerpt.length} chars</span>}
              />
              <Field label="Content length" value={<span className="font-mono">{pack.content.length} chars</span>} />
            </dl>
          </div>

          <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
            <h2 className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
              Excerpt
            </h2>
            <p className="mt-2 text-xs text-(--color-text-tertiary)">{pack.contentExcerpt || '—'}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="font-display font-bold uppercase tracking-wider text-(--color-text-secondary)">{label}</dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}
