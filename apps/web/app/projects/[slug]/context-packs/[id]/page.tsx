import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import { Breadcrumbs, Card, type Crumb, PageHeader, PageShell, Section } from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { getContextPack } from '@/lib/queries/context-packs';

/**
 * `/projects/[slug]/context-packs/[id]` — Context Pack detail (M04
 * Phase 2 S9, restyled in Phase 2 UI).
 */

export const dynamic = 'force-dynamic';

export default async function ContextPackDetailPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const pack = await getContextPack(id);
  if (pack === null) notFound();
  if (pack.projectId !== project.id) notFound();
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Context packs', href: `${baseHref}/context-packs` },
    { label: pack.title },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Context pack"
        title={pack.title}
        subtitle={
          <>
            Saved <span className="font-mono">{formatDate(pack.createdAt)}</span> from run{' '}
            <Link
              href={`${baseHref}/runs/${encodeURIComponent(pack.runId)}` as never}
              className="font-mono text-brand hover:underline"
            >
              {pack.runId}
            </Link>
            .
          </>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <article>
          <Card size="md">
            <MarkdownRenderer body={pack.content} />
          </Card>
        </article>

        <aside className="flex flex-col gap-(--space-stack)">
          <Section title="Metadata">
            <Card size="sm">
              <dl className="flex flex-col gap-2 text-xs">
                <Field label="Pack id" value={<span className="font-mono">{pack.id}</span>} />
                <Field
                  label="Run id"
                  value={
                    <Link
                      href={`${baseHref}/runs/${encodeURIComponent(pack.runId)}` as never}
                      className="font-mono text-brand hover:underline"
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
            </Card>
          </Section>

          <Section title="Excerpt">
            <Card size="sm">
              <p className="text-xs text-text-tertiary">{pack.contentExcerpt || '—'}</p>
            </Card>
          </Section>
        </aside>
      </div>
    </PageShell>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-xs font-medium text-text-secondary">{label}</dt>
      <dd className="text-text-primary">{value}</dd>
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
