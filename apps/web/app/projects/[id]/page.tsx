import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RunStatusChip } from '@/components/RunStatusChip';
import { resetProjectAction } from '@/lib/actions/projects';
import { getProject } from '@/lib/queries/projects';

/**
 * `/projects/[id]` — server-rendered project detail per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/projects.md`.
 *
 * Three anchored sections:
 *   - Overview — counts (runs total + status histogram)
 *   - Recent runs — last N runs as table rows linking to /runs/[id]
 *   - Reset — destructive form (type-to-confirm, --keep-policies default)
 *
 * The __global__ sentinel project shows the Reset section as a banner
 * explaining why it cannot be reset from the UI.
 */

interface SearchParams {
  readonly error?: string;
}

const GLOBAL_PROJECT_ID = '__global__';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const sp = await searchParams;
  const project = await getProject(id);
  if (project === null) notFound();

  const isSentinel = project.slug === GLOBAL_PROJECT_ID;
  const statusEntries = Object.entries(project.statusCounts).sort(([a], [b]) => a.localeCompare(b));
  const totalRuns = project.runCount;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-4">
          <h1 className="font-mono text-3xl font-medium text-(--color-text-primary)">{project.slug}</h1>
          {isSentinel ? (
            <span className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-tertiary)">
              sentinel · F7
            </span>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
          <Field label="ID" value={<span className="font-mono">{project.id}</span>} />
          <Field label="Org" value={<span className="font-mono">{project.orgId}</span>} />
          <Field label="Name" value={project.name} />
          <Field
            label="Created"
            value={<span className="font-mono">{project.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</span>}
          />
        </dl>
      </header>

      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          ✕ {sp.error}
        </div>
      ) : null}

      <Section title="Overview">
        <div className="grid gap-4 md:grid-cols-3">
          <Tile label="Total runs" value={totalRuns} status="info" />
          {statusEntries.map(([status, count]) => (
            <Tile key={status} label={status} value={count} status="neutral" statusChip={status} />
          ))}
        </div>
      </Section>

      <Section title={`Recent runs (${project.recentRuns.length})`}>
        {project.recentRuns.length === 0 ? (
          <Empty hint="No runs in this project yet." />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>ID</Th>
                <Th>Session</Th>
                <Th>Agent</Th>
                <Th>Status</Th>
                <Th>Started</Th>
              </tr>
            </thead>
            <tbody>
              {project.recentRuns.map((run) => (
                <tr key={run.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-2">
                    <Link
                      href={`/runs/${encodeURIComponent(run.id)}` as never}
                      className="font-mono text-xs font-medium text-(--color-text-code) hover:text-(--color-brand-hover)"
                    >
                      {run.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{run.sessionId}</td>
                  <td className="px-3 py-2 font-mono text-xs">{run.agentType}</td>
                  <td className="px-3 py-2">
                    <RunStatusChip status={run.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-secondary)">
                    {run.startedAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Reset project">
        {isSentinel ? (
          <div className="border-l-4 border-(--color-status-warning) bg-(--color-status-warning)/10 px-4 py-3 text-sm">
            The <span className="font-mono">__global__</span> sentinel project (F7 invariant) cannot be reset from this
            UI. To clear <span className="font-mono">__global__</span> rows, run{' '}
            <span className="font-mono">contextos project reset __global__ --force</span> after backing up data.db.
          </div>
        ) : (
          <form
            action={resetProjectAction}
            className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6"
          >
            <input type="hidden" name="identifier" value={project.id} />
            <p className="mb-4 text-sm text-(--color-text-primary)">
              Resetting <span className="font-mono">{project.slug}</span> will delete every per-run audit row for this
              project: runs, run_events, decisions, policy_decisions, context_packs.
            </p>
            <ul className="mb-4 ml-6 list-disc text-xs text-(--color-text-secondary)">
              <li>Total runs to delete: {totalRuns}</li>
              <li>Cascade order matches the CLI's `contextos project reset` (FK-aware)</li>
              <li>Default: keeps policies + policy_rules + project-scoped kill_switches</li>
            </ul>
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input type="checkbox" name="alsoDeletePolicies" />
              <span>Also delete policies + policy_rules + project-scoped kill_switches</span>
            </label>
            <label
              htmlFor="reset-confirm"
              className="mb-1 block font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)"
            >
              Type the project slug to confirm:
            </label>
            <input
              id="reset-confirm"
              type="text"
              name="confirmation"
              required
              autoComplete="off"
              placeholder={project.slug}
              className="mb-4 w-full max-w-md border border-(--color-border-default) bg-(--color-bg-base) px-3 py-2 font-mono text-sm text-(--color-text-primary)"
            />
            <button
              type="submit"
              className="bg-(--color-status-error) px-6 py-2 font-display text-xs font-bold uppercase tracking-wider text-white hover:opacity-80"
            >
              Reset
            </button>
          </form>
        )}
      </Section>

      <div>
        <Link
          href="/projects"
          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
        >
          ◂ Back to projects
        </Link>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  status,
  statusChip,
}: {
  readonly label: string;
  readonly value: number;
  readonly status: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  readonly statusChip?: string;
}) {
  const colorClass: Record<typeof status, string> = {
    info: 'text-(--color-status-info)',
    success: 'text-(--color-status-success)',
    warning: 'text-(--color-status-warning)',
    error: 'text-(--color-status-error)',
    neutral: 'text-(--color-text-primary)',
  };
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}
      </div>
      <div className={`mt-2 font-display text-4xl font-black ${colorClass[status]}`}>{value}</div>
      {statusChip !== undefined ? (
        <div className="mt-1 font-mono text-xs text-(--color-text-tertiary)">{statusChip}</div>
      ) : null}
    </div>
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

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-tertiary)">
      {hint}
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
