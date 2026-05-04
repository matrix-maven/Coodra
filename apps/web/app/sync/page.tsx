import Link from 'next/link';

import { retryQueueAction, retrySingleJobAction } from '@/lib/actions/sync';
import { fetchSyncSnapshot } from '@/lib/queries/sync';

/**
 * `/sync` — durable-outbox + sync-daemon admin (M04 Phase 2 S15).
 *
 * Reads the local `pending_jobs` table grouped by (queue, status).
 * The local outbox carries every audit write that's still in-flight
 * to the sync_to_cloud queue (in team mode) or to the local cloud-
 * write loop (currently a no-op in solo mode).
 *
 * Two operator actions:
 *   - Per-row retry (flip one dead job back to pending).
 *   - Per-queue retry-all (flip every dead job in a queue back to
 *     pending). The sync-daemon will pick them up on the next poll.
 *
 * In solo mode the page still renders — pending_jobs is the local
 * outbox even when there's no cloud target. The "Mode" header tells
 * the operator what context they're looking at.
 */

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly retried?: string;
  readonly retriedQueue?: string;
  readonly count?: string;
  readonly error?: string;
}

export default async function SyncPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const snapshot = await fetchSyncSnapshot();

  const totalPending = snapshot.queues.reduce((sum, q) => sum + q.pending, 0);
  const totalPicked = snapshot.queues.reduce((sum, q) => sum + q.picked, 0);
  const totalDead = snapshot.queues.reduce((sum, q) => sum + q.dead, 0);

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-8 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-black uppercase tracking-wide text-(--color-text-primary)">Sync</h1>
        <p className="text-sm text-(--color-text-secondary)">
          Durable-outbox + sync-daemon view. Mode: <span className="font-mono">{snapshot.mode}</span> · last fetched{' '}
          <span className="font-mono">{snapshot.fetchedAt}</span>.
        </p>
      </header>

      <Banners {...sp} />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Tile label="Pending" value={totalPending} tone={totalPending > 0 ? 'info' : 'success'} />
        <Tile label="In-flight (picked)" value={totalPicked} tone={totalPicked > 0 ? 'warning' : 'success'} />
        <Tile label="Dead-letter" value={totalDead} tone={totalDead > 0 ? 'error' : 'success'} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">
          Per-queue depth
        </h2>
        {snapshot.queues.length === 0 ? (
          <Empty hint="The pending_jobs table is empty. Either the outbox has nothing to dispatch, or the daemon has drained everything." />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>Queue</Th>
                <Th>Pending</Th>
                <Th>Picked</Th>
                <Th>Dead</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.queues.map((q) => (
                <tr key={q.queue} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-2 font-mono text-sm text-(--color-text-primary)">{q.queue}</td>
                  <td className="px-3 py-2 font-mono text-sm text-(--color-status-info)">{q.pending}</td>
                  <td className="px-3 py-2 font-mono text-sm text-(--color-status-warning)">{q.picked}</td>
                  <td className="px-3 py-2 font-mono text-sm text-(--color-status-error)">{q.dead}</td>
                  <td className="px-3 py-2">
                    {q.dead > 0 ? (
                      <form action={retryQueueAction}>
                        <input type="hidden" name="queue" value={q.queue} />
                        <button
                          type="submit"
                          className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
                        >
                          Retry {q.dead} dead ▸
                        </button>
                      </form>
                    ) : (
                      <span className="font-display text-xs text-(--color-text-tertiary)">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-display text-xl font-bold uppercase tracking-wide text-(--color-text-primary)">
          Recent dead jobs
        </h2>
        {snapshot.recentDead.length === 0 ? (
          <Empty hint="No dead-letter jobs in the outbox." />
        ) : (
          <table className="w-full border border-(--color-border-subtle)">
            <thead className="bg-(--color-bg-elevated)">
              <tr>
                <Th>ID</Th>
                <Th>Queue</Th>
                <Th>Attempts</Th>
                <Th>Failed</Th>
                <Th>Last error</Th>
                <Th>Retry</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.recentDead.map((j) => (
                <tr key={j.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-surface)">
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{j.id.slice(0, 12)}…</td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-secondary)">{j.queue}</td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">{j.attempts}</td>
                  <td className="px-3 py-2 font-mono text-xs text-(--color-text-tertiary)">
                    {j.failedAt !== null ? j.failedAt.toISOString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-(--color-text-secondary)">
                    {j.lastError !== null ? truncate(j.lastError, 120) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <form action={retrySingleJobAction}>
                      <input type="hidden" name="id" value={j.id} />
                      <button
                        type="submit"
                        className="font-display text-xs font-bold uppercase tracking-wider text-(--color-brand) hover:text-(--color-brand-hover)"
                      >
                        Retry
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-(--color-text-tertiary)">
        See{' '}
        <Link href="/projects/coodra-dev/logs/sync-daemon" className="text-(--color-brand) hover:underline">
          sync-daemon logs
        </Link>{' '}
        for the daemon's view of these queues.
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: 'success' | 'warning' | 'error' | 'info';
}) {
  const colorClass: Record<typeof tone, string> = {
    success: 'text-(--color-status-success)',
    warning: 'text-(--color-status-warning)',
    error: 'text-(--color-status-error)',
    info: 'text-(--color-status-info)',
  };
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
      <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
        {label}
      </div>
      <div className={`mt-2 font-display text-5xl font-black ${colorClass[tone]}`}>{value}</div>
    </div>
  );
}

function Empty({ hint }: { readonly hint: string }) {
  return (
    <div className="border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 text-center text-sm text-(--color-text-secondary)">
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

function Banners(sp: SearchParams) {
  return (
    <div className="flex flex-col gap-2">
      {sp.retried !== undefined ? (
        <div className="border-l-4 border-(--color-status-success) bg-(--color-status-success)/10 px-4 py-3 text-sm">
          ✓ Retried <span className="font-mono">{sp.retried}</span> job{sp.retried === '1' ? '' : 's'}.
        </div>
      ) : null}
      {sp.retriedQueue !== undefined ? (
        <div className="border-l-4 border-(--color-status-success) bg-(--color-status-success)/10 px-4 py-3 text-sm">
          ✓ Retried <span className="font-mono">{sp.count ?? '?'}</span> dead jobs in queue{' '}
          <span className="font-mono">{sp.retriedQueue}</span>.
        </div>
      ) : null}
      {sp.error !== undefined ? (
        <div className="border-l-4 border-(--color-status-error) bg-(--color-status-error)/10 px-4 py-3 text-sm">
          ✕ <span className="font-mono">{sp.error}</span>
        </div>
      ) : null}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
