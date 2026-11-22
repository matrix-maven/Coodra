import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fmtClockSec } from '@/lib/format';
import { getTelemetrySession, type TelemetrySessionDetail } from '@/lib/queries/telemetry';
import {
  DISAGREEMENT_LABEL,
  fmtCostMicros,
  fmtInt,
  fmtMs,
  REASON_LABEL,
  STATUS_LABEL,
  shortId,
} from '@/lib/telemetry-format';

export const dynamic = 'force-dynamic';

const OPERATIONS_SHOWN = 300;

export default async function TelemetrySessionPage({
  params,
}: {
  params: Promise<{ projectId: string; sessionId: string }>;
}) {
  const { projectId: rawProject, sessionId: rawSession } = await params;
  const projectId = decodeURIComponent(rawProject);
  const sessionId = decodeURIComponent(rawSession);
  const dm = resolveDeploymentMode();
  const d = await getTelemetrySession(projectId, sessionId);

  return (
    <>
      <Topbar crumb="Agent telemetry" crumbPrefix={dm === 'team-hosted' ? 'coodra · team' : 'coodra · solo'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              <Link href="/telemetry">/06 · AGENT TELEMETRY</Link> · SESSION
            </div>
            <h1 className="head__title">
              Session <em>{shortId(sessionId, 12)}</em>
            </h1>
            <p className="head__lede">
              {d.harness ?? 'unknown harness'} · {d.projectSlug ?? projectId} ·{' '}
              {d.run === null ? (
                'no Run exists for this session (evidence is unattached and expires after 24 hours)'
              ) : (
                <>
                  Run <Link href={`/runs/${encodeURIComponent(d.run.id)}`}>{shortId(d.run.id, 16)}</Link> (
                  {d.run.status})
                </>
              )}
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{fmtInt(d.eventsTotal)} events</strong>
              <br />
              {d.firstAtMs === null ? '—' : fmtClockSec(new Date(d.firstAtMs))}
              <br />→ {d.lastAtMs === null ? '—' : fmtClockSec(new Date(d.lastAtMs))}
            </div>
          </div>
        </div>

        {d.localOnly ? (
          <div className="empty">
            <strong>
              Telemetry is <em>local</em>.
            </strong>
            <p>Native telemetry is not synced to team Postgres; open this page from the local dashboard.</p>
          </div>
        ) : !d.found ? (
          <div className="empty">
            <strong>
              No telemetry for this <em>session</em>.
            </strong>
            <p>
              Nothing is stored for this project and session. It may have expired (7 days, or 24 hours when no Run
              existed) or was never received.
            </p>
          </div>
        ) : (
          <>
            <Summary d={d} />
            <Verification d={d} />
            <UsageSection d={d} />
            <HookHealth d={d} />
            <McpSection d={d} />
            <Events d={d} />
          </>
        )}
        <footer>
          <p className="muted">Fetched {d.fetchedAt}</p>
        </footer>
      </section>
    </>
  );
}

function Card({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__num">{warn === true ? <em>{value}</em> : value}</div>
      <div className={warn === true ? 'stat__delta stat__delta--down' : 'stat__delta'}>{sub}</div>
    </div>
  );
}

function Summary({ d }: { d: TelemetrySessionDetail }) {
  const u = d.usage;
  const s = d.reconciliation.summary;
  return (
    <section>
      <div className="stats">
        <Card
          label="Model requests"
          value={fmtInt(u.requests)}
          sub={`${fmtInt(u.inputTokens)} in · ${fmtInt(u.outputTokens)} out · ${d.apiErrors} error(s)`}
          warn={d.apiErrors > 0}
        />
        <Card
          label="Estimated cost"
          value={fmtCostMicros(u.costUsdMicros)}
          sub={
            u.costUsdMicros === null
              ? 'no request reported a cost'
              : `provider estimate · ${u.requestsWithCost}/${u.requests} requests`
          }
        />
        <Card
          label="Operations"
          value={fmtInt(s.total)}
          sub={`${s.matched} matched · ${s.hookOnly} hook-only · ${s.telemetryOnly} telemetry-only`}
          warn={s.hookOnly + s.telemetryOnly + s.matchedWithDisagreement > 0}
        />
        <Card
          label="Collection queue"
          value={`${d.queue.pending}`}
          sub={`${d.queue.dead} dead-lettered${
            d.queue.oldestPendingAgeSec === null ? '' : ` · oldest pending ${d.queue.oldestPendingAgeSec}s`
          }`}
          warn={d.queue.dead > 0}
        />
      </div>
    </section>
  );
}

function Verification({ d }: { d: TelemetrySessionDetail }) {
  const r = d.reconciliation;
  const ops = r.operations.slice(0, OPERATIONS_SHOWN);
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Capture <em>verification</em>
        </h2>
        <span className="card__role">Hooks vs telemetry, by native tool-use id</span>
      </div>
      <div className="stats">
        <Card
          label="Matched"
          value={`${r.summary.matched}`}
          sub={`${r.summary.matchedWithDisagreement} with disagreement`}
          warn={r.summary.matchedWithDisagreement > 0}
        />
        <Card
          label="Hook-only"
          value={`${r.summary.hookOnly}`}
          sub="no telemetry result"
          warn={r.summary.hookOnly > 0}
        />
        <Card
          label="Telemetry-only"
          value={`${r.summary.telemetryOnly}`}
          sub="no hook records"
          warn={r.summary.telemetryOnly > 0}
        />
        <Card label="Awaiting arrival" value={`${r.summary.awaitingArrival}`} sub="within grace window" />
        <Card label="Not comparable" value={`${r.summary.notComparable}`} sub="see reason per row" />
      </div>
      <ul style={{ margin: '0 0 24px 18px', color: 'var(--muted, inherit)' }}>
        {r.limitations.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {ops.length === 0 ? (
        <p className="head__lede">No tool operations were recorded by either channel.</p>
      ) : (
        <div className="card" style={{ padding: 0, marginBottom: 56 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Status</th>
                <th>Tool</th>
                <th>Native tool-use id</th>
                <th>Hooks (policy outcome)</th>
                <th>Telemetry</th>
                <th>Notes</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {ops.map((o, i) => (
                <tr key={`${o.nativeToolUseId ?? 'none'}:${o.hook?.rowIds[0] ?? o.telemetry?.evidenceId ?? i}`}>
                  <td>
                    <span
                      className={o.status === 'matched' && o.disagreements.length === 0 ? 'badge' : 'badge badge--warn'}
                    >
                      <span className="badge__dot" />
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                  <td>
                    <code>{o.toolName ?? '—'}</code>
                  </td>
                  <td>
                    <code>{o.nativeToolUseId === null ? '—' : shortId(o.nativeToolUseId, 14)}</code>
                  </td>
                  <td>
                    {o.hook === null
                      ? '—'
                      : `${o.hook.pre ? 'pre' : ''}${o.hook.pre && o.hook.post ? ' + ' : ''}${o.hook.post ? 'post' : ''}${
                          o.hook.outcome === null ? '' : ` (${o.hook.outcome})`
                        }`}
                  </td>
                  <td>
                    {o.telemetry === null
                      ? '—'
                      : `${o.telemetry.success === null ? 'status n/a' : o.telemetry.success ? 'success' : 'failed'} · ${fmtMs(
                          o.telemetry.durationMs,
                        )}${o.telemetry.occurrences > 1 ? ` · ×${o.telemetry.occurrences}` : ''}`}
                  </td>
                  <td>
                    {[
                      ...(o.reason === undefined ? [] : [REASON_LABEL[o.reason] ?? o.reason]),
                      ...o.disagreements.map((c) => DISAGREEMENT_LABEL[c] ?? c),
                      ...(o.toolNameDiffers ? ['tool name differs between channels'] : []),
                    ].join('; ') || '—'}
                  </td>
                  <td className="tbl__mono">
                    {[
                      ...(o.hook?.rowIds ?? []).map((id) => `run_events ${shortId(id, 8)}`),
                      ...(o.telemetry === null ? [] : [`telemetry ${shortId(o.telemetry.evidenceId, 20)}`]),
                    ].join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.operations.length > OPERATIONS_SHOWN ? (
        <p className="muted">
          Showing the first {OPERATIONS_SHOWN} of {r.operations.length} operations; the counts above cover all of them.
        </p>
      ) : null}
    </section>
  );
}

function UsageSection({ d }: { d: TelemetrySessionDetail }) {
  if (d.usageByModel.length === 0) return null;
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Usage <em>by model</em>
        </h2>
        <span className="card__role">Provider estimates, not billing</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Requests</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache write</th>
              <th className="num">Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {d.usageByModel.map((m) => (
              <tr key={m.model}>
                <td>
                  <code>{m.model}</code>
                </td>
                <td className="num">{fmtInt(m.requests)}</td>
                <td className="num">{fmtInt(m.inputTokens)}</td>
                <td className="num">{fmtInt(m.outputTokens)}</td>
                <td className="num">{fmtInt(m.cacheReadTokens)}</td>
                <td className="num">{fmtInt(m.cacheCreationTokens)}</td>
                <td className="num">{fmtCostMicros(m.costUsdMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function HookHealth({ d }: { d: TelemetrySessionDetail }) {
  if (d.hookHealth.length === 0) return null;
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Hook <em>health</em>
        </h2>
        <span className="card__role">As the harness saw it — all hooks per event, not Coodra alone</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Hook event</th>
              <th className="num">Executions</th>
              <th className="num">Hooks run</th>
              <th className="num">Succeeded</th>
              <th className="num">Blocking</th>
              <th className="num">Errors</th>
              <th className="num">Cancelled</th>
              <th className="num">Avg</th>
              <th className="num">Max</th>
            </tr>
          </thead>
          <tbody>
            {d.hookHealth.map((h) => (
              <tr key={h.hookEvent}>
                <td>
                  <code>{h.hookEvent}</code>
                </td>
                <td className="num">{h.executions}</td>
                <td className="num">{h.hooks}</td>
                <td className="num">{h.succeeded}</td>
                <td className="num">{h.blocking}</td>
                <td className="num">{h.errors > 0 ? <em>{h.errors}</em> : h.errors}</td>
                <td className="num">{h.cancelled}</td>
                <td className="num">{fmtMs(h.avgMs)}</td>
                <td className="num">{fmtMs(h.maxMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function McpSection({ d }: { d: TelemetrySessionDetail }) {
  if (d.mcpConnections.length === 0) return null;
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          MCP <em>connections</em>
        </h2>
        <span className="card__role">The harness does not name the server</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Status</th>
              <th>Transport</th>
              <th>Scope</th>
              <th className="num">Count</th>
              <th className="num">Slowest</th>
            </tr>
          </thead>
          <tbody>
            {d.mcpConnections.map((c) => (
              <tr key={`${c.status}:${c.transportType}:${c.serverScope}`}>
                <td>
                  <span className={c.status === 'connected' ? 'badge' : 'badge badge--warn'}>
                    <span className="badge__dot" />
                    {c.status}
                  </span>
                </td>
                <td>
                  <code>{c.transportType}</code>
                </td>
                <td>
                  <code>{c.serverScope}</code>
                </td>
                <td className="num">{c.count}</td>
                <td className="num">{fmtMs(c.maxMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Events({ d }: { d: TelemetrySessionDetail }) {
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Evidence <em>rows</em>
        </h2>
        <span className="card__role">
          Newest first · {d.events.length} of {fmtInt(d.eventsTotal)} ·{' '}
          <Link href={`/telemetry/events?session=${encodeURIComponent(d.sessionId)}`}>open in raw events</Link>
        </span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Event</th>
              <th>Detail</th>
              <th className="num">Duration</th>
              <th>Source time</th>
              <th>Row id</th>
            </tr>
          </thead>
          <tbody>
            {d.events.map((e) => (
              <tr key={e.id}>
                <td>
                  <code>{e.eventName.replace('claude_code.', '')}</code>
                  {e.attached ? null : <span className="badge badge--warn"> unattached</span>}
                </td>
                <td>
                  {[
                    e.toolName,
                    e.success === null ? null : e.success ? 'success' : 'failed',
                    e.model,
                    e.hookEvent,
                    e.connectionStatus,
                    e.inputTokens === null ? null : `${fmtInt(e.inputTokens)}/${fmtInt(e.outputTokens ?? 0)} tok`,
                    e.costKind === 'provider_estimate' ? fmtCostMicros(e.costUsdMicros) : null,
                  ]
                    .filter((x): x is string => x !== null && x !== '')
                    .join(' · ') || '—'}
                </td>
                <td className="num">{fmtMs(e.durationMs)}</td>
                <td>{fmtClockSec(new Date(e.sourceAtMs))}</td>
                <td className="tbl__mono">{shortId(e.id, 22)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
