import { Topbar } from '@/components/Topbar';
import { retryQueueAction, retrySingleJobAction } from '@/lib/actions/sync';
import { fmtRelative } from '@/lib/format';
import { fetchSyncSnapshot } from '@/lib/queries/sync';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly retried?: string;
  readonly retriedQueue?: string;
  readonly count?: string;
  readonly error?: string;
}

export default async function SyncPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const snap = await fetchSyncSnapshot();
  const totals = snap.queues.reduce(
    (acc, q) => ({
      pending: acc.pending + q.pending,
      picked: acc.picked + q.picked,
      dead: acc.dead + q.dead,
    }),
    { pending: 0, picked: 0, dead: 0 },
  );

  return (
    <>
      <Topbar crumb="Sync queue" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · SYSTEM · SYNC</div>
            <h1 className="head__title">
              Local rows, <em>cloud</em> tables.
            </h1>
            <p className="head__lede">
              Every audit row written locally also enqueues a job. The daemon drains it. Lease, retry, dead-letter —
              same shape as the policy outbox.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>queue depth · {totals.pending}</strong>
              <br />
              {totals.picked} leased
              <br />
              {totals.dead} dead
            </div>
          </div>
        </div>

        {sp.retried !== undefined ? (
          <Banner tone="ok">Retried · {sp.retried} job(s) flipped back to pending.</Banner>
        ) : null}
        {sp.retriedQueue !== undefined ? (
          <Banner tone="ok">
            Retried queue {sp.retriedQueue} · {sp.count} jobs flipped.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">Error: {sp.error}</Banner> : null}

        <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 32 }}>
          <div className="stat">
            <div className="stat__label">Pending</div>
            <div className="stat__num">{totals.pending === 0 ? <em>0</em> : totals.pending}</div>
            <div className="stat__delta">jobs waiting</div>
          </div>
          <div className="stat">
            <div className="stat__label">Leased</div>
            <div className="stat__num">{totals.picked}</div>
            <div className="stat__delta">in flight</div>
          </div>
          <div className="stat">
            <div className="stat__label">Dead-letter</div>
            <div className="stat__num">{totals.dead === 0 ? <em>0</em> : totals.dead}</div>
            <div className="stat__delta">{totals.dead === 0 ? 'no failures' : 'review below'}</div>
          </div>
        </div>

        <div className="card" style={{ padding: 0, marginBottom: 24 }}>
          <div style={cardHead}>
            <h2 className="card__title">
              Queues · <em>by depth</em>
            </h2>
            <span className="card__role">{snap.queues.length} queues · live</span>
          </div>
          {snap.queues.length === 0 ? (
            <div className="empty" style={{ border: 'none' }}>
              <strong>
                No queues <em>active</em>.
              </strong>
              {snap.mode === 'team'
                ? 'Cloud sync is configured but has no jobs yet.'
                : 'Solo mode keeps everything local; no sync needed.'}
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th style={{ textAlign: 'right' }}>Pending</th>
                  <th style={{ textAlign: 'right' }}>Leased</th>
                  <th style={{ textAlign: 'right' }}>Dead</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {snap.queues.map((q) => (
                  <tr key={q.queue}>
                    <td className="tbl__mono">{q.queue}</td>
                    <td className="tbl__mono" style={{ textAlign: 'right' }}>
                      {q.pending}
                    </td>
                    <td className="tbl__mono" style={{ textAlign: 'right' }}>
                      {q.picked}
                    </td>
                    <td
                      className="tbl__mono"
                      style={{ textAlign: 'right', color: q.dead > 0 ? 'var(--warn)' : 'inherit' }}
                    >
                      {q.dead}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {q.dead > 0 ? (
                        <form action={retryQueueAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="queue" value={q.queue} />
                          <button className="btn btn--sm btn--ghost" type="submit">
                            Retry {q.dead} dead
                          </button>
                        </form>
                      ) : (
                        <span style={{ color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 10 }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {snap.recentDead.length > 0 ? (
          <div className="card" style={{ padding: 0 }}>
            <div style={cardHead}>
              <h2 className="card__title">
                Recent <em>dead-letter</em>
              </h2>
              <span className="card__role">last 20</span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Queue</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th style={{ textAlign: 'right' }}>Failed</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {snap.recentDead.map((j) => (
                  <tr key={j.id}>
                    <td className="tbl__mono">{j.id.slice(0, 12)}</td>
                    <td className="tbl__mono">{j.queue}</td>
                    <td className="tbl__mono">{j.attempts}</td>
                    <td
                      className="tbl__mono"
                      style={{
                        color: 'var(--warn)',
                        maxWidth: 360,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {j.lastError ?? '—'}
                    </td>
                    <td className="tbl__mono" style={{ textAlign: 'right' }}>
                      {j.failedAt === null ? '—' : fmtRelative(j.failedAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <form action={retrySingleJobAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="id" value={j.id} />
                        <button className="btn btn--sm btn--ghost" type="submit">
                          Retry
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}

const cardHead: React.CSSProperties = {
  padding: '24px 28px',
  borderBottom: '1px solid var(--rule)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

function Banner({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
}
