import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusChip } from '@/components/StatusChip';
import {
  Breadcrumbs,
  type Crumb,
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
import { listRunsAndContextPacksForProject } from '@/lib/queries/pack-runs';
import { getPack } from '@/lib/queries/packs';

/**
 * `/projects/[slug]/packs/[packSlug]/runs` — pack-scoped activity panel
 * (M04 Phase 2 S7, restyled in Phase 2 UI).
 */

export const dynamic = 'force-dynamic';

const RUNS_LIMIT = 50;
const CONTEXT_PACKS_LIMIT = 50;

export default async function PackActivityPage({ params }: { params: Promise<{ slug: string; packSlug: string }> }) {
  const project = await resolveProjectFromParams(params);
  const { packSlug: rawPackSlug } = await params;
  const packSlug = decodeURIComponent(rawPackSlug);
  const pack = getPack(packSlug);
  if (pack === null) notFound();
  if (pack.slug !== project.slug && pack.parentSlug !== project.slug) notFound();

  const { runs, contextPacks, hasMoreRuns } = await listRunsAndContextPacksForProject({
    projectId: project.id,
    runsLimit: RUNS_LIMIT,
    contextPacksLimit: CONTEXT_PACKS_LIMIT,
  });

  const baseHref = `/projects/${encodeURIComponent(project.slug)}`;
  const packHref = `${baseHref}/packs/${encodeURIComponent(pack.slug)}`;
  const trail: ReadonlyArray<Crumb> = [
    { label: 'Projects', href: '/' },
    { label: project.slug, href: baseHref, mono: true },
    { label: 'Packs', href: `${baseHref}/packs` },
    { label: pack.slug, href: packHref, mono: true },
    { label: 'Activity' },
  ];

  return (
    <PageShell>
      <Breadcrumbs trail={trail} />
      <PageHeader
        eyebrow="Pack · activity"
        title="Activity"
        code={pack.slug}
        subtitle={
          <>
            Runs and context packs for the project{' '}
            <Link href={baseHref as never} className="font-mono text-brand hover:underline">
              {project.slug}
            </Link>{' '}
            that owns this pack. Pack-grain filtering arrives with M05 — the schema does not yet store the feature-pack
            FK on runs or context packs.
          </>
        }
      />

      <Section
        title="Context packs"
        count={`${contextPacks.length}${contextPacks.length === CONTEXT_PACKS_LIMIT ? '+' : ''}`}
      >
        {contextPacks.length === 0 ? (
          <EmptyState
            title="No context packs yet"
            body="Context packs are written when an agent calls save_context_pack (or when the bridge auto-fires on Stop / SessionEnd)."
          />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Title</TH>
                <TH>Created</TH>
                <TH>Excerpt</TH>
                <TH>Run</TH>
              </TR>
            </THead>
            <TBody>
              {contextPacks.map((cp) => (
                <TR key={cp.id}>
                  <TD mono>
                    <Link
                      href={`${baseHref}/context-packs/${encodeURIComponent(cp.id)}` as never}
                      className="text-brand hover:underline"
                    >
                      {cp.title}
                    </Link>
                  </TD>
                  <TD mono muted>
                    {formatDate(cp.createdAt)}
                  </TD>
                  <TD muted truncate>
                    {cp.contentExcerpt}
                  </TD>
                  <TD mono muted>
                    <Link
                      href={`${baseHref}/runs/${encodeURIComponent(cp.runId)}` as never}
                      className="hover:text-brand"
                    >
                      {cp.runId.slice(0, 8)}…
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Runs" count={`${runs.length}${hasMoreRuns ? '+' : ''}`}>
        {runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Start an agent session against this project — Claude Code's SessionStart hook records a run row via the bridge."
          />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Run</TH>
                <TH>Agent</TH>
                <TH>Status</TH>
                <TH>Started</TH>
                <TH>Ended</TH>
              </TR>
            </THead>
            <TBody>
              {runs.map((r) => (
                <TR key={r.id}>
                  <TD mono>
                    <Link
                      href={`${baseHref}/runs/${encodeURIComponent(r.id)}` as never}
                      className="text-brand hover:underline"
                    >
                      {r.id.slice(0, 8)}…
                    </Link>
                  </TD>
                  <TD mono muted>
                    {r.agentType}
                  </TD>
                  <TD>
                    <StatusChip status={statusKind(r.status)}>{r.status}</StatusChip>
                  </TD>
                  <TD mono muted>
                    {formatDate(r.startedAt)}
                  </TD>
                  <TD mono muted>
                    {r.endedAt === null ? '—' : formatDate(r.endedAt)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>
    </PageShell>
  );
}

function statusKind(status: string): 'success' | 'warning' | 'error' | 'neutral' | 'info' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'info';
    case 'cancelled':
      return 'warning';
    case 'failed':
    case 'abandoned':
      return 'error';
    default:
      return 'neutral';
  }
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
