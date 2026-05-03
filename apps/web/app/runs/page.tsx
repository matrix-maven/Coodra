import Link from 'next/link';

import { RunRow } from '@/components/RunRow';
import { listProjectsForFilter, listRuns } from '@/lib/queries/runs';

/**
 * `/runs` — server-rendered run list per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/runs-list.md`.
 *
 * URL state holds the filter:
 *   ?status=in_progress|completed|cancelled|failed
 *   ?project=<projectId>
 *   ?limit=<N>  (default 50; "Show more" link doubles)
 *
 * Live URL state means the filter is shareable — paste a `/runs?status=failed`
 * link into Slack and the recipient sees the same view.
 */

interface SearchParams {
  readonly status?: string;
  readonly project?: string;
  readonly limit?: string;
}

const STATUS_OPTIONS = ['', 'in_progress', 'completed', 'cancelled', 'failed'] as const;

export default async function RunsListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const limit = clampLimit(params.limit);
  const filter = {
    ...(params.status !== undefined && params.status !== '' ? { status: params.status } : {}),
    ...(params.project !== undefined && params.project !== '' ? { projectId: params.project } : {}),
    limit,
  };
  const [{ runs, hasMore }, projects] = await Promise.all([listRuns(filter), listProjectsForFilter()]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Runs</h1>
        <p className="text-sm text-(--color-text-secondary)">
          {runs.length} run{runs.length === 1 ? '' : 's'} shown, sorted by started_at descending.
        </p>
      </header>

      <form className="flex flex-wrap gap-4 border border-(--color-border-subtle) bg-(--color-bg-surface) p-4">
        <Filter
          label="Status"
          name="status"
          value={params.status ?? ''}
          options={STATUS_OPTIONS.map((s) => ({ value: s, label: s === '' ? 'All' : s }))}
        />
        <Filter
          label="Project"
          name="project"
          value={params.project ?? ''}
          options={[{ value: '', label: 'All' }, ...projects.map((p) => ({ value: p.id, label: p.slug }))]}
        />
        <input type="hidden" name="limit" value={String(limit)} />
        <button
          type="submit"
          className="self-end bg-(--color-brand) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:bg-(--color-brand-hover)"
        >
          Apply
        </button>
        {(params.status !== undefined && params.status !== '') ||
        (params.project !== undefined && params.project !== '') ? (
          <Link
            href="/runs"
            className="self-end border border-(--color-border-default) px-4 py-2 font-display text-xs font-bold uppercase tracking-wider text-(--color-text-primary) hover:border-(--color-brand) hover:text-(--color-brand)"
          >
            Reset
          </Link>
        ) : null}
      </form>

      {runs.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="w-full border border-(--color-border-subtle)">
          <thead className="bg-(--color-bg-elevated)">
            <tr>
              <Th>ID</Th>
              <Th>Status</Th>
              <Th>Agent</Th>
              <Th>Started</Th>
              <Th>Session</Th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <RunRow
                key={run.id}
                id={run.id}
                status={run.status}
                agentType={run.agentType}
                sessionId={run.sessionId}
                startedAt={run.startedAt}
                endedAt={run.endedAt}
              />
            ))}
          </tbody>
        </table>
      )}

      {hasMore ? (
        <div className="self-center">
          <Link
            href={{
              pathname: '/runs',
              query: {
                ...(params.status !== undefined ? { status: params.status } : {}),
                ...(params.project !== undefined ? { project: params.project } : {}),
                limit: String(limit * 2),
              },
            }}
            className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
          >
            Show more ▸
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Th({ children }: { readonly children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
      {children}
    </th>
  );
}

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

function Filter({
  label,
  name,
  value,
  options,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly options: ReadonlyArray<FilterOption>;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="border border-(--color-border-default) bg-(--color-bg-base) px-3 py-2 font-sans text-sm text-(--color-text-primary)"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyState() {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-12 text-center">
      <p className="font-display text-lg font-light uppercase tracking-wider text-(--color-text-secondary)">
        No runs match the current filter.
      </p>
      <p className="mt-2 text-sm text-(--color-text-tertiary)">Reset filters or open Claude Code to generate one.</p>
    </div>
  );
}

function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(n, 1000);
}
