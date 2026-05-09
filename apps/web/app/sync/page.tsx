import {
  Banner,
  Button,
  EmptyState,
  LinkButton,
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
import { retryQueueAction, retrySingleJobAction } from '@/lib/actions/sync';
import { fetchSyncSnapshot } from '@/lib/queries/sync';

/**
 * `/sync` — editorial sync queue (mirrors brand-kit Sync, screen 12).
 *
 * Hero + 3-cell stat row + per-queue table + recent-dead table.
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
  const totalDrained = snapshot.queues.reduce(
    (sum, q) => sum + ((q as unknown as { completed?: number }).completed ?? 0),
    0,
  );

  return (
    <PageShell variant="workspace">
      <PageHeader
        eyebrow="/05 · SYSTEM · SYNC"
        title={
          <>
            Local rows, <em>cloud</em> tables.
          </>
        }
        subtitle={
          <>
            Every audit row written locally also enqueues a sync_to_cloud job. The daemon drains it. Lease, retry,
            dead-letter — same shape as the policy outbox. Mode:{' '}
            <span className="font-mono text-accent">{snapshot.mode}</span>.
          </>
        }
        meta={
          <>
            <strong className="font-medium text-text-primary">queue depth · {totalPending + totalPicked}</strong>
            <br />
            last fetched · {snapshot.fetchedAt}
            <br />
            cloud · {snapshot.mode === 'team' ? 'connected' : 'idle'}
          </>
        }
        actions={
          <>
            <LinkButton href="/sync" variant="ghost">
              Force drain
            </LinkButton>
            <LinkButton href="/settings/workspace" variant="primary">
              Configure cloud
            </LinkButton>
          </>
        }
      />

      <Banners {...sp} />

      <div className="mb-14 grid grid-cols-3 border-y border-rule">
        <StatCell label="Pending" value={totalPending} hint="awaiting dispatcher" emphasis={totalPending > 0} divider />
        <StatCell
          label="In flight"
          value={totalPicked}
          hint={`${totalDrained || '—'} drained · 24h`}
          tone={totalPicked > 0 ? 'success' : 'neutral'}
          divider
        />
        <StatCell
          label="Dead-letter"
          value={totalDead}
          hint={totalDead === 0 ? 'no failures' : 'exhausted retries'}
          tone={totalDead > 0 ? 'error' : 'neutral'}
        />
      </div>

      <div className="mb-12">
        <Section
          title={
            <>
              Per-queue <em>depth</em>
            </>
          }
          count={`${snapshot.queues.length} · queues`}
        >
          {snapshot.queues.length === 0 ? (
            <EmptyState
              title={
                <>
                  Outbox <em>empty</em>
                </>
              }
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
                            Retry {q.dead}
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
      </div>

      <Section
        title={
          <>
            Recent <em>dead jobs</em>
          </>
        }
        count={`${snapshot.recentDead.length} · last 24h`}
      >
        {snapshot.recentDead.length === 0 ? (
          <EmptyState
            title={
              <>
                No <em>dead-letter</em> jobs
              </>
            }
            body="Every queued job has either dispatched or is still pending."
          />
        ) : (
          <Table>
            <THead>
              <TR hoverable={false}>
                <TH>Job</TH>
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
                    {j.failedAt !== null ? j.failedAt.toISOString().slice(11, 19) : '—'}
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
    </PageShell>
  );
}

function StatCell({
  label,
  value,
  hint,
  emphasis,
  tone,
  divider,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly hint: string;
  readonly emphasis?: boolean;
  readonly tone?: 'neutral' | 'success' | 'error';
  readonly divider?: boolean;
}) {
  const dividerCls = divider === true ? 'border-r border-rule' : '';
  const hintCls = tone === 'error' ? 'text-status-error' : tone === 'success' ? 'text-accent' : 'text-text-tertiary';
  return (
    <div className={`px-7 py-8 ${dividerCls}`}>
      <div className="eyebrow mb-5 text-text-tertiary">{label}</div>
      <div className="num-display text-[64px] leading-[0.95] text-text-primary">
        {emphasis ? <em>{value}</em> : value}
      </div>
      <div className={`mt-3 font-mono text-[10px] tracking-[0.08em] ${hintCls}`}>{hint}</div>
    </div>
  );
}

function Banners(sp: SearchParams) {
  if (sp.retried === undefined && sp.retriedQueue === undefined && sp.error === undefined) return null;
  return (
    <div className="mb-8 flex flex-col gap-2">
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
