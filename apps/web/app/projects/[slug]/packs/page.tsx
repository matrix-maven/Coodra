import Link from 'next/link';

import { AlertTriangleIcon, Banner, EmptyState, LinkButton, PageHeader, PageShell, StatPill } from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listPacks } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs` — editorial feature pack grid (mirrors
 * brand-kit Feature Packs, screen 08).
 *
 * 3-column card grid; each card has eyebrow / serif italic title /
 * mono excerpt / sync footer.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly deleted?: string;
}

export default async function PacksListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const allPacks = listPacks();
  const packs = allPacks.filter((p) => p.slug === project.slug || p.parentSlug === project.slug);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}/packs`;

  return (
    <PageShell>
      <PageHeader
        eyebrow="/04 · KNOWLEDGE · FEATURE PACKS"
        title={
          <>
            Three voices: <em>spec</em>, plan, stack.
          </>
        }
        subtitle="A feature pack is the durable record of a module: the why, the how, the dependency graph. Auto-injected on SessionStart. Edit on disk; we sync the metadata."
        meta={
          <>
            <strong className="font-medium text-text-primary">
              {packs.length} pack{packs.length === 1 ? '' : 's'}
            </strong>
            <br />
            scope · {project.slug}
            <br />
            docs/feature-packs/
          </>
        }
        actions={
          <>
            <LinkButton href={baseHref} variant="ghost">
              Pack scan
            </LinkButton>
            <LinkButton href={baseHref} variant="primary">
              New pack
            </LinkButton>
          </>
        }
      />

      {sp.deleted !== undefined ? (
        <div className="mb-8">
          <Banner kind="success">
            Pack <span className="font-mono">{sp.deleted}</span> deleted (dir removed + is_active=false).
          </Banner>
        </div>
      ) : null}

      {packs.length === 0 ? (
        <EmptyState
          title={
            <>
              No <em>packs</em>
            </>
          }
          body={
            <>
              Run <span className="font-mono text-accent">contextos pack new &lt;slug&gt;</span> in{' '}
              <span className="font-mono text-accent">{project.slug}</span> to scaffold one.
            </>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {packs.map((p, idx) => (
            <Link
              key={p.slug}
              href={`${baseHref}/${encodeURIComponent(p.slug)}` as never}
              className="group flex cursor-pointer flex-col border border-rule bg-bg-surface p-7 transition-colors hover:border-accent"
            >
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent">
                / {String(idx + 1).padStart(2, '0')} · {p.slug.toUpperCase()}
              </div>
              <h3 className="heading-display mt-3.5 mb-3 text-[28px] leading-[1.05] text-text-primary">
                {p.parentSlug !== null ? (
                  <>
                    Inherits from{' '}
                    <em>
                      <span>{p.parentSlug}</span>
                    </em>
                  </>
                ) : (
                  <>
                    A <em>module</em> in {project.slug}
                  </>
                )}
              </h3>
              <p className="mb-6 text-[13px] leading-[1.6] text-text-tertiary">
                {p.fileCount}/4 spec files on disk
                {p.parentSlug !== null ? `, parent ${p.parentSlug}` : ''}. Active flag in DB,{' '}
                {p.isActive ? 'currently advertised to agents' : 'currently dormant'}.
              </p>
              <div className="flex items-center gap-4 border-t border-rule pt-4 font-mono text-[10px] uppercase tracking-[0.06em] text-text-muted">
                <span className={p.hasSpec ? 'text-text-tertiary' : 'opacity-40'}>spec.md</span>
                <span className={p.hasImplementation ? 'text-text-tertiary' : 'opacity-40'}>impl.md</span>
                <span className={p.hasTechstack ? 'text-text-tertiary' : 'opacity-40'}>stack.md</span>
                <span className="ml-auto flex items-center gap-2">
                  {p.fileCount < 4 ? (
                    <span className="flex items-center gap-1.5 text-status-warning">
                      <AlertTriangleIcon className="h-3 w-3" />
                      INCOMPLETE
                    </span>
                  ) : (
                    <StatPill tone={p.isActive ? 'ok' : 'neutral'} dot>
                      {p.isActive ? 'SYNCED' : 'INACTIVE'}
                    </StatPill>
                  )}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
