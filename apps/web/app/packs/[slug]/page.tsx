import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusChip } from '@/components/StatusChip';
import { getPack } from '@/lib/queries/packs';

/**
 * `/packs/[slug]` — server-rendered pack detail per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/packs.md`.
 *
 * S7 ships read-only sections for each of the 4 files. The dedicated
 * markdown→HTML renderer lands in S11 alongside the per-event
 * response shaping cleanup; for now we use a code-block render
 * (always-correct fallback that preserves layout).
 *
 * M04 Phase 2 S1 (F1, OQ-9 lock): force-dynamic so file edits to
 * spec.md/implementation.md/techstack.md show up on the next visit
 * without a rebuild.
 */
export const dynamic = 'force-dynamic';

export default async function PackDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = decodeURIComponent(rawSlug);
  const pack = getPack(slug);
  if (pack === null) notFound();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-3xl font-medium text-(--color-text-primary)">{pack.slug}</h1>
          <StatusChip status={pack.isActive ? 'success' : 'neutral'}>
            {pack.isActive ? 'active' : 'inactive'}
          </StatusChip>
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
      </header>

      <Section title="spec.md">
        <FileBody body={pack.spec} />
      </Section>

      <Section title="implementation.md">
        <FileBody body={pack.implementation} />
      </Section>

      <Section title="techstack.md">
        <FileBody body={pack.techstack} />
      </Section>

      <Section title="meta.json">
        <FileBody body={pack.metaRaw} mono />
      </Section>

      <div>
        <Link
          href="/packs"
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
