import Link from 'next/link';

import { getTelemetrySession, hasAnyTelemetry } from '@/lib/queries/telemetry';
import { fmtCostMicros, fmtInt } from '@/lib/telemetry-format';

/**
 * Agent telemetry for one Run (COOD-105): what the harness reported for this session, set against
 * Coodra's hook records. Rendered only on machines that have received telemetry at all, so Runs on
 * installs that never enabled it are not cluttered. Observations only; see /telemetry for caveats.
 */
export async function RunTelemetryPanel({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  if (!(await hasAnyTelemetry())) return null;
  const d = await getTelemetrySession(projectId, sessionId);
  if (d.localOnly) return null;

  const box: React.CSSProperties = {
    borderTop: '1px solid var(--rule)',
    borderBottom: '1px solid var(--rule)',
    marginBottom: 32,
    padding: '14px 0',
  };
  if (!d.found) {
    return (
      <div style={box}>
        <div className="stat__label">Agent telemetry</div>
        <p className="muted" style={{ margin: '6px 0 0' }}>
          No native telemetry was received for this run. The harness may not have been configured to export it, or the
          data expired. <Link href="/telemetry">About Agent telemetry</Link>
        </p>
      </div>
    );
  }

  const s = d.reconciliation.summary;
  const attention = s.hookOnly + s.telemetryOnly + s.matchedWithDisagreement;
  return (
    <div style={box}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}
      >
        <div className="stat__label">Agent telemetry</div>
        <div>
          <Link href={`/telemetry/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`}>
            Open telemetry →
          </Link>
          {' · '}
          <Link href={`/telemetry/events?session=${encodeURIComponent(sessionId)}`}>Raw events</Link>
        </div>
      </div>
      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginTop: 10 }}
      >
        <div>
          <div className="stat__num">{fmtInt(s.total)}</div>
          <div className={attention > 0 ? 'stat__delta stat__delta--down' : 'stat__delta'}>
            operations · {s.matched} matched · {s.hookOnly} hook-only · {s.telemetryOnly} telemetry-only
            {s.matchedWithDisagreement > 0 ? ` · ${s.matchedWithDisagreement} disagree` : ''}
            {s.awaitingArrival > 0 ? ` · ${s.awaitingArrival} awaiting` : ''}
            {s.notComparable > 0 ? ` · ${s.notComparable} not comparable` : ''}
          </div>
        </div>
        <div>
          <div className="stat__num">{fmtInt(d.usage.requests)}</div>
          <div className="stat__delta">
            model requests · {fmtInt(d.usage.inputTokens)} in / {fmtInt(d.usage.outputTokens)} out · est. cost{' '}
            {fmtCostMicros(d.usage.costUsdMicros)}
          </div>
        </div>
        <div>
          <div className="stat__num">{fmtInt(d.hookHealth.reduce((n, h) => n + h.errors, 0))}</div>
          <div className="stat__delta">hook errors reported by the harness · {d.apiErrors} API error(s)</div>
        </div>
        <div>
          <div className="stat__num">{d.queue.pending}</div>
          <div className={d.queue.dead > 0 ? 'stat__delta stat__delta--down' : 'stat__delta'}>
            queued · {d.queue.dead} dead-lettered
          </div>
        </div>
      </div>
    </div>
  );
}
