import {
  Banner,
  Button,
  EmptyState,
  LinkButton,
  PageHeader,
  PageShell,
  Section,
  StatusDot,
  Table,
  TBody,
  TD,
  TH,
  THead,
  Tile,
  TR,
} from '@/components/ui';
import { retryQueueAction, retrySingleJobAction } from '@/lib/actions/sync';
import { fetchSyncSnapshot } from '@/lib/queries/sync';

/**
 * `/sync` — durable-outbox + sync-daemon admin (M04 Phase 2 S15,
 * restyled in Phase 2 UI).
 *
 * Reads the local `pending_jobs` table grouped by (queue, status).
 * Three KPI tiles + per-queue table + recent-dead table. All composed
 * from shared primitives so spacing + typography match every other
 * surface.
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
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="Workspace"
        title="Sync"
        subtitle={
          <>
            Durable-outbox + sync-daemon view. Mode: <span className="font-mono">{snapshot.mode}</span> · last fetched{' '}
            <span className="font-mono">{snapshot.fetchedAt}</span>.
          </>
        }
      />

      <Banners {...sp} />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Tile
          label="Pending"
          value={totalPending}
          tone={totalPending > 0 ? 'info' : 'success'}
          hint="Awaiting dispatcher"
        />
        <Tile
          label="In flight"
          value={totalPicked}
          tone={totalPicked > 0 ? 'warning' : 'success'}
          hint="Picked, not yet acknowledged"
        />
        <Tile
          label="Dead-letter"
          value={totalDead}
          tone={totalDead > 0 ? 'error' : 'success'}
          hint="Exhausted retries"
        />
      </section>

      <Section title="Per-queue depth" count={snapshot.queues.length}>
        {snapshot.queues.length === 0 ? (
          <EmptyState
            title="Outbox empty"
            body="The pending_jobs table has no rows. Either nothing has been enqueued, or the daemon has drained everything."
          />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Queue</TH>
                <TH align="right">Pending</TH>
                <TH align="right">Picked</TH>
                <TH align="right">Dead</TH>
                <TH align="right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {snapshot.queues.map((q) => (
                <TR key={q.queue}>
                  <TD mono>{q.queue}</TD>
                  <TD align="right" mono>
                    {q.pending}
                  </TD>
                  <TD align="right" mono>
                    {q.picked}
                  </TD>
                  <TD align="right" mono>
                    {q.dead}
                  </TD>
                  <TD align="right">
                    {q.dead > 0 ? (
                      <form action={retryQueueAction} className="inline-flex">
                        <input type="hidden" name="queue" value={q.queue} />
                        <Button type="submit" size="sm" variant="ghost">
                          Retry {q.dead} dead
                        </Button>
                      </form>
                    ) : (
                      <span className="text-text-tertiary">—</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <Section title="Recent dead jobs" count={snapshot.recentDead.length}>
        {snapshot.recentDead.length === 0 ? (
          <EmptyState title="No dead-letter jobs" body="Every queued job has either dispatched or is still pending." />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>ID</TH>
                <TH>Queue</TH>
                <TH align="right">Attempts</TH>
                <TH>Failed</TH>
                <TH>Last error</TH>
                <TH align="right">Action</TH>
              </TR>
            </THead>
            <TBody>
              {snapshot.recentDead.map((j) => (
                <TR key={j.id}>
                  <TD mono muted>
                    {j.id.slice(0, 12)}…
                  </TD>
                  <TD mono>{j.queue}</TD>
                  <TD align="right" mono muted>
                    {j.attempts}
                  </TD>
                  <TD mono muted>
                    {j.failedAt !== null ? j.failedAt.toISOString() : '—'}
                  </TD>
                  <TD truncate>{j.lastError !== null ? truncate(j.lastError, 120) : '—'}</TD>
                  <TD align="right">
                    <form action={retrySingleJobAction} className="inline-flex">
                      <input type="hidden" name="id" value={j.id} />
                      <Button type="submit" size="sm" variant="ghost">
                        Retry
                      </Button>
                    </form>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Section>

      <p className="flex items-center gap-2 text-xs text-text-tertiary">
        <StatusDot tone={totalDead > 0 ? 'error' : 'success'} size="sm" />
        <span>
          See{' '}
          <LinkButton href="/projects/coodra-dev/logs/sync-daemon" variant="ghost" size="sm">
            sync-daemon logs
          </LinkButton>{' '}
          for the daemon's view of these queues.
        </span>
      </p>
    </PageShell>
  );
}

function Banners(sp: SearchParams) {
  if (sp.retried === undefined && sp.retriedQueue === undefined && sp.error === undefined) return null;
  return (
    <div className="flex flex-col gap-2">
      {sp.retried !== undefined ? (
        <Banner kind="success">
          Retried <span className="font-mono">{sp.retried}</span> job{sp.retried === '1' ? '' : 's'}.
        </Banner>
      ) : null}
      {sp.retriedQueue !== undefined ? (
        <Banner kind="success">
          Retried <span className="font-mono">{sp.count ?? '?'}</span> dead jobs in queue{' '}
          <span className="font-mono">{sp.retriedQueue}</span>.
        </Banner>
      ) : null}
      {sp.error !== undefined ? (
        <Banner kind="error" code={sp.error}>
          —
        </Banner>
      ) : null}
    </div>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
