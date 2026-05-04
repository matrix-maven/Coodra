import Link from 'next/link';

import { StatusChip } from '@/components/StatusChip';
import {
  AlertTriangleIcon,
  Banner,
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listPacks } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs` — Feature packs scoped to the URL-bound
 * project (M04 Phase 2 S2a IA migration, restyled in Phase 2 UI).
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

  return (
    <PageShell>
      <PageHeader
        eyebrow="Project · packs"
        title="Feature packs"
        subtitle={
          <>
            Packs owned by <span className="font-mono">{project.slug}</span> (slug or parent matches).
          </>
        }
      />

      {sp.deleted !== undefined ? (
        <Banner kind="success">
          Pack <span className="font-mono">{sp.deleted}</span> deleted (dir removed + is_active=false).
        </Banner>
      ) : null}

      {packs.length === 0 ? (
        <EmptyState
          title="No feature packs"
          body={
            <>
              Run <span className="font-mono">contextos pack new &lt;slug&gt;</span> in{' '}
              <span className="font-mono">{project.slug}</span> to scaffold one.
            </>
          }
        />
      ) : (
        <Section title="All packs" count={packs.length}>
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Slug</TH>
                <TH>Parent</TH>
                <TH>Active</TH>
                <TH>Files</TH>
                <TH align="right">Open</TH>
              </TR>
            </THead>
            <TBody>
              {packs.map((p) => (
                <TR key={p.slug}>
                  <TD mono>{p.slug}</TD>
                  <TD mono muted>
                    {p.parentSlug ?? '—'}
                  </TD>
                  <TD>
                    <StatusChip status={p.isActive ? 'success' : 'neutral'}>
                      {p.isActive ? 'active' : 'inactive'}
                    </StatusChip>
                  </TD>
                  <TD mono>
                    <span className="inline-flex items-center gap-2">
                      {p.fileCount}/4
                      {p.fileCount < 4 ? (
                        <AlertTriangleIcon
                          className="h-3 w-3 text-status-warning"
                          aria-label={`Missing: ${[
                            !p.hasMeta && 'meta.json',
                            !p.hasSpec && 'spec.md',
                            !p.hasImplementation && 'implementation.md',
                            !p.hasTechstack && 'techstack.md',
                          ]
                            .filter(Boolean)
                            .join(', ')}`}
                        />
                      ) : null}
                    </span>
                  </TD>
                  <TD align="right">
                    <Link
                      href={
                        `/projects/${encodeURIComponent(project.slug)}/packs/${encodeURIComponent(p.slug)}` as never
                      }
                      className="text-xs font-medium text-brand transition-colors duration-200 hover:text-brand-hover"
                    >
                      View
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      )}
    </PageShell>
  );
}
