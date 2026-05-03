import { StatusChip } from '@/components/StatusChip';
import { ToolBadge } from '@/components/ToolBadge';
import { getActor } from '@/lib/auth';

/**
 * S1 placeholder home. The real dashboard (5 tiles + recent events list)
 * lands in S9 per docs/feature-packs/04-web-app/wireframes/02-screens/dashboard.md.
 *
 * What this page does today: prove the storage adapter resolves, the
 * brand tokens render, and the chrome (HeaderNav + Breadcrumb) renders
 * in both modes. It's the smallest surface that exercises every S1
 * acceptance check end-to-end.
 */
export default async function HomePlaceholder() {
  const actor = await getActor();
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide">Dashboard</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Module 04 S1 scaffold. The real dashboard (5 tiles + latest events) lands in S9.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <PlaceholderTile label="Mode" value={actor.mode} status={actor.mode === 'team' ? 'info' : 'neutral'} />
        <PlaceholderTile label="Actor" value={actor.userId} status="neutral" />
        <PlaceholderTile label="Org" value={actor.orgId} status="neutral" />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide">Brand primitives</h2>
        <div className="flex flex-wrap gap-2">
          <StatusChip status="success">Allowed</StatusChip>
          <StatusChip status="warning">Partial</StatusChip>
          <StatusChip status="error">Denied</StatusChip>
          <StatusChip status="info">Info</StatusChip>
          <StatusChip status="neutral">Inactive</StatusChip>
        </div>
        <div className="flex flex-wrap gap-2">
          <ToolBadge name="Write" />
          <ToolBadge name="Edit" />
          <ToolBadge name="Bash" />
          <ToolBadge name="MultiEdit" />
          <ToolBadge name="NotebookEdit" />
        </div>
      </section>
    </div>
  );
}

function PlaceholderTile({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: 'success' | 'warning' | 'error' | 'info' | 'neutral';
}) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <div className="font-display text-xs font-bold uppercase tracking-wide text-(--color-text-secondary)">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl font-medium text-(--color-text-primary)">{value}</div>
      <div className="mt-4">
        <StatusChip status={status}>{status}</StatusChip>
      </div>
    </div>
  );
}
