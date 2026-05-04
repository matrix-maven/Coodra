import { ProjectCard } from '@/components/ProjectCard';
import { EmptyState, LinkButton, PageHeader, PageShell, PlusIcon } from '@/components/ui';
import { fetchPickerSnapshot } from '@/lib/queries/picker';

/**
 * `/` — Project picker hub (M04 Phase 2 S2b — replaces the Phase 1
 * cross-project dashboard).
 *
 * Renders every registered project (excluding the `__global__`
 * sentinel) as a clickable `<ProjectCard>`. Each card shows per-
 * project tile counts + a status dot + last-activity timestamp.
 * Composed from the shared primitives library so the workspace
 * gutter / vertical rhythm matches /sync, /init, /settings/*.
 */

export const dynamic = 'force-dynamic';

export default async function ProjectPickerPage() {
  const snapshot = await fetchPickerSnapshot();
  return (
    <PageShell variant="workspace">
      <PageHeader
        title="Projects"
        subtitle={
          <>
            {snapshot.projects.length} project{snapshot.projects.length === 1 ? '' : 's'} ·{' '}
            <span className="font-mono uppercase">{snapshot.mode}</span> mode · sorted by last activity.
          </>
        }
        actions={
          <LinkButton href="/init" variant="primary" leftIcon={<PlusIcon className="h-3 w-3" />}>
            New project
          </LinkButton>
        }
      />

      {snapshot.projects.length === 0 ? (
        <EmptyState
          size="lg"
          title="No projects yet"
          body={
            <>
              ContextOS organises everything around projects. Create one from the web wizard, or run{' '}
              <span className="font-mono">contextos init --project-slug X --no-graphify --ide claude</span> in a project
              root.
            </>
          }
          action={
            <LinkButton href="/init" variant="primary" leftIcon={<PlusIcon className="h-3 w-3" />}>
              Create project
            </LinkButton>
          }
        />
      ) : (
        <section className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {snapshot.projects.map((p) => (
            <ProjectCard
              key={p.id}
              slug={p.slug}
              name={p.name}
              orgId={p.orgId}
              activeRuns={p.activeRuns}
              denials24h={p.denials24h}
              activeKillSwitches={p.activeKillSwitches}
              lastActivityAt={p.lastActivityAt}
              statusDot={p.statusDot}
            />
          ))}
        </section>
      )}

      <footer className="text-center text-xs text-text-tertiary">
        Last refreshed {new Date(snapshot.fetchedAt).toLocaleTimeString()}
      </footer>
    </PageShell>
  );
}
