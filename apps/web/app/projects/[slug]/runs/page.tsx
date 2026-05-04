import { RunRow } from '@/components/RunRow';
import {
  Button,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  Select,
  Table,
  TBody,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { resolveProjectFromParams } from '@/lib/project-context';
import { listRuns } from '@/lib/queries/runs';

/**
 * `/projects/[slug]/runs` — server-rendered run list, scoped to the
 * URL-bound project (M04 Phase 2 S2a IA migration; restyled in
 * Phase 2 UI).
 */
export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly status?: string;
  readonly limit?: string;
}

const STATUS_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: '', label: 'All' },
  { value: 'in_progress', label: 'in_progress' },
  { value: 'completed', label: 'completed' },
  { value: 'cancelled', label: 'cancelled' },
  { value: 'failed', label: 'failed' },
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

  return (
    <PageShell>
      <PageHeader
        eyebrow="Project · runs"
        title="Runs"
        subtitle={
          <>
            {runs.length} run{runs.length === 1 ? '' : 's'} for <span className="font-mono">{project.slug}</span>,
            sorted by started_at descending.
          </>
        }
      />

      <Card size="sm">
        <form className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="runs-status" className="text-xs font-medium text-text-secondary">
              Status
            </label>
            <Select id="runs-status" name="status" defaultValue={sp.status ?? ''} className="w-48" mono>
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>
          <input type="hidden" name="limit" value={String(limit)} />
          <Button type="submit" variant="primary">
            Apply filter
          </Button>
          {sp.status !== undefined && sp.status !== '' ? (
            <LinkButton href={baseHref} variant="ghost">
              Reset
            </LinkButton>
          ) : null}
        </form>
      </Card>

      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body={
            <>
              Open Claude Code in <span className="font-mono">{project.slug}</span> to generate one.
            </>
          }
        />
      ) : (
        <Section title="All runs" count={`${runs.length}${hasMore ? '+' : ''}`}>
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>ID</TH>
                <TH>Status</TH>
                <TH>Agent</TH>
                <TH>Started</TH>
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
        <div className="self-center">
          <LinkButton
            href={`${baseHref}?${new URLSearchParams({
              ...(sp.status !== undefined ? { status: sp.status } : {}),
              limit: String(limit * 2),
            }).toString()}`}
            variant="ghost"
          >
            Show more
          </LinkButton>
        </div>
      ) : null}
    </PageShell>
  );
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}
