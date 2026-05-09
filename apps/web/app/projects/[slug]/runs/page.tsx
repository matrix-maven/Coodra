import Link from 'next/link';

import { RunRow } from '@/components/RunRow';
import { EmptyState, LinkButton, PageHeader, PageShell, Section, Table, TBody, TH, THead, TR } from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listRuns } from '@/lib/queries/runs';

/**
 * `/projects/[slug]/runs` — editorial run list (mirrors brand-kit
 * Runs List, screen 03). Status pill tabs sit above an editorial
 * data table.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly status?: string;
  readonly limit?: string;
}

const STATUS_FILTERS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'All' },
  { value: 'in_progress', label: 'Running' },
  { value: 'completed', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
];

export default async function RunsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const limit = clampLimit(sp.limit);
  const filter = {
    projectId: project.id,
    ...(sp.status !== undefined && sp.status !== '' ? { status: sp.status } : {}),
    limit,
  };
  const { runs, hasMore } = await listRuns(filter);
  const baseHref = `/projects/${encodeURIComponent(project.slug)}/runs`;
  const activeStatus = sp.status ?? '';

  return (
    <PageShell>
      <PageHeader
        eyebrow="/02 · AUDIT"
        title={
          <>
            Every <em>run</em>, every event.
          </>
        }
        subtitle="A run is one Claude / Cursor / Windsurf session against a project. Every tool call is a row; every row carries a verdict. Nothing is reconstructed — it's recorded."
        meta={
          <>
            <strong className="font-medium text-text-primary">
              {runs.length}
              {hasMore ? '+' : ''} runs
            </strong>
            <br />
            scope · {project.slug}
            <br />
            sorted · started desc
          </>
        }
        actions={
          <>
            <LinkButton href={baseHref} variant="ghost">
              Filter
            </LinkButton>
            <LinkButton href={baseHref} variant="secondary">
              Export
            </LinkButton>
          </>
        }
      />

      {/* Filter pills · editorial */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
        <nav aria-label="Filter by status" className="flex flex-wrap items-center gap-1.5">
          {STATUS_FILTERS.map((opt) => {
            const isActive = activeStatus === opt.value;
            const href = opt.value === '' ? baseHref : `${baseHref}?status=${encodeURIComponent(opt.value)}`;
            return (
              <Link
                key={opt.value || '_all'}
                href={href as never}
                aria-current={isActive ? 'page' : undefined}
                className={`inline-flex h-8 items-center gap-2 border px-3 font-mono text-[10px] font-medium uppercase tracking-[0.16em] transition-colors ${
                  isActive
                    ? 'border-accent text-accent'
                    : 'border-rule-strong text-text-tertiary hover:border-text-primary hover:text-text-primary'
                }`}
              >
                {opt.value !== '' ? <StatusDotFor value={opt.value} /> : null}
                {opt.label}
              </Link>
            );
          })}
        </nav>
        {activeStatus !== '' ? (
          <LinkButton href={baseHref} variant="ghost" size="sm">
            Clear filter
          </LinkButton>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title={
            <>
              No <em>runs</em> match
            </>
          }
          body={
            activeStatus !== '' ? (
              <>
                No runs with status <span className="font-mono text-accent">{activeStatus}</span>. Try a different
                filter.
              </>
            ) : (
              <>
                Open Claude Code in <span className="font-mono text-accent">{project.slug}</span> to generate one.
              </>
            )
          }
          action={
            activeStatus !== '' ? (
              <LinkButton href={baseHref} variant="secondary" size="sm">
                Show all runs
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Section
          title={
            <>
              All <em>runs</em>
            </>
          }
          count={`${runs.length}${hasMore ? '+' : ''} · last ${limit}`}
        >
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH width="120px">Status</TH>
                <TH>Run</TH>
                <TH width="140px">Agent</TH>
                <TH width="160px">Started</TH>
                <TH>Session</TH>
              </TR>
            </THead>
            <TBody>
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  id={run.id}
                  status={run.status}
                  agentType={run.agentType}
                  sessionId={run.sessionId}
                  startedAt={run.startedAt}
                  endedAt={run.endedAt}
                  projectSlug={project.slug}
                />
              ))}
            </TBody>
          </Table>
        </Section>
      )}

      {hasMore ? (
        <div className="mt-8 self-center">
          <LinkButton
            href={`${baseHref}?${new URLSearchParams({
              ...(sp.status !== undefined ? { status: sp.status } : {}),
              limit: String(limit * 2),
            }).toString()}`}
            variant="secondary"
            size="sm"
          >
            Show more
          </LinkButton>
        </div>
      ) : null}
    </PageShell>
  );
}

function StatusDotFor({ value }: { readonly value: string }) {
  const cls =
    value === 'in_progress'
      ? 'bg-accent shadow-[0_0_6px_var(--color-accent-glow)]'
      : value === 'completed'
        ? 'bg-accent'
        : value === 'cancelled'
          ? 'bg-text-muted'
          : value === 'failed'
            ? 'bg-status-error'
            : 'bg-text-muted';
  return <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${cls}`} />;
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}
