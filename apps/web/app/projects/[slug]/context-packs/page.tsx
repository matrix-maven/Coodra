import Link from 'next/link';

import {
  Breadcrumbs,
  type Crumb,
  EmptyState,
  LinkButton,
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
import { listContextPacks } from '@/lib/queries/context-packs';

/**
 * `/projects/[slug]/context-packs` — Context Packs list (M04 Phase 2 S9,
 * restyled in Phase 2 UI).
 */

export const dynamic = 'force-dynamic';

const PAGE_LIMIT = 100;

export default async function ContextPacksListPage({ params }: { params: Promise<{ slug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const packs = await listContextPacks({ projectId: project.id, limit: PAGE_LIMIT });
  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Context packs' },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Project · artifacts"
        title="Context packs"
        subtitle={
          <>
            {packs.length}
            {packs.length === PAGE_LIMIT ? '+' : ''} pack{packs.length === 1 ? '' : 's'} for{' '}
            <span className="font-mono">{project.slug}</span>, newest first.
          </>
        }
      />

      {packs.length === 0 ? (
        <EmptyState
          title="No context packs yet"
          body={
            <>
              Context packs land when an agent calls <span className="font-mono">save_context_pack</span> at session end
              (or when the hooks-bridge auto-fires on Stop / SessionEnd per ADR-012).
            </>
          }
        />
      ) : (
        <Section title="All packs" count={`${packs.length}${packs.length === PAGE_LIMIT ? '+' : ''}`}>
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Title</TH>
                <TH>Created</TH>
                <TH>Excerpt</TH>
                <TH>Run</TH>
                <TH align="right">Open</TH>
              </TR>
            </THead>
            <TBody>
              {packs.map((p) => {
                const detailHref = `${baseHref}/context-packs/${encodeURIComponent(p.id)}`;
                return (
                  <TR key={p.id}>
                    <TD mono>
                      <Link
                        href={detailHref as never}
                        className="text-brand transition-colors duration-200 hover:text-brand-hover hover:underline"
                      >
                        {p.title}
                      </Link>
                    </TD>
                    <TD mono muted>
                      {formatDate(p.createdAt)}
                    </TD>
                    <TD muted truncate>
                      {p.contentExcerpt}
                    </TD>
                    <TD mono muted>
                      <Link
                        href={`${baseHref}/runs/${encodeURIComponent(p.runId)}` as never}
                        className="hover:text-brand"
                      >
                        {p.runId.slice(0, 8)}…
                      </Link>
                    </TD>
                    <TD align="right">
                      <LinkButton href={detailHref} variant="ghost" size="sm">
                        Open
                      </LinkButton>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Section>
      )}
    </PageShell>
  );
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
