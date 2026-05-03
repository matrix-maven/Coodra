import Link from 'next/link';

import { listProjects } from '@/lib/queries/projects';

/**
 * `/projects` — server-rendered list of every project per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/projects.md`.
 * Cards layout (one per project) instead of a table — better at
 * highlighting per-project run counts.
 */

interface SearchParams {
  readonly reset?: string;
  readonly summary?: string;
  readonly error?: string;
}

export default async function ProjectsListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const projects = await listProjects();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Projects</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Every project registered in this install — solo: just the current cwd; team: every project in the org.
        </p>
      </header>

      {sp.reset !== undefined ? (
        <div className="border-l-4 border-(--color-status-success) bg-(--color-status-success)/10 px-4 py-3 text-sm">
          ✓ Reset <span className="font-mono">{sp.reset}</span>.
          {sp.summary !== undefined ? (
            <span className="ml-2 text-(--color-text-secondary)">Deleted: {sp.summary}.</span>
          ) : null}
        </div>
      ) : null}
      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          ✕ {sp.error}
        </div>
      ) : null}

      {projects.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} {...p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  id,
  slug,
  orgId,
  name,
  runCount,
  lastRunAt,
}: {
  readonly id: string;
  readonly slug: string;
  readonly orgId: string;
  readonly name: string;
  readonly runCount: number;
  readonly lastRunAt: Date | null;
}) {
  const isSentinel = slug === '__global__';
  return (
    <Link
      href={`/projects/${encodeURIComponent(id)}` as never}
      className="flex flex-col gap-3 border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 hover:border-(--color-brand)"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-2xl font-medium text-(--color-text-primary)">{slug}</span>
        {isSentinel ? (
          <span className="font-display text-[10px] font-bold uppercase tracking-wider text-(--color-text-tertiary)">
            sentinel · F7
          </span>
        ) : null}
      </div>
      {name !== slug ? <span className="text-sm text-(--color-text-secondary)">{name}</span> : null}
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <Field label="Org" value={<span className="font-mono">{orgId}</span>} />
        <Field label="Runs" value={<span className="font-mono text-sm font-medium">{runCount}</span>} />
        <Field
          label="Last run"
          value={
            <span className="font-mono">
              {lastRunAt === null ? '—' : lastRunAt.toISOString().slice(0, 16).replace('T', ' ')}
            </span>
          }
        />
      </dl>
      <div className="border-t border-(--color-border-subtle) pt-2 text-xs font-bold uppercase tracking-wider text-(--color-brand)">
        View ▸
      </div>
    </Link>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="font-display text-[10px] font-bold uppercase tracking-wider text-(--color-text-tertiary)">
        {label}
      </dt>
      <dd className="text-(--color-text-primary)">{value}</dd>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-12 text-center">
      <p className="font-display text-lg font-light uppercase tracking-wider text-(--color-text-secondary)">
        No projects registered.
      </p>
      <p className="mt-2 text-sm text-(--color-text-tertiary)">
        Run `contextos init` in a project directory to register it.
      </p>
    </div>
  );
}
