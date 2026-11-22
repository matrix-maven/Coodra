import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { listTelemetrySessions, type TelemetrySessionRow } from '@/lib/queries/telemetry';
import { fmtCostMicros, fmtInt, shortId } from '@/lib/telemetry-format';

export const dynamic = 'force-dynamic';

/**
 * `/telemetry` — Agent telemetry (COOD-105).
 *
 * What the harness itself reported (Claude Code's native OpenTelemetry logs), set against what
 * Coodra's hooks recorded. This is not Memory utilization (what Coodra surfaced) and it is not
 * an audit of the agent; it answers "which operations reached Coodra, and where do the two
 * channels disagree?". Absence of telemetry is never presented as proof that nothing happened.
 */
export default async function AgentTelemetryPage() {
  const dm = resolveDeploymentMode();
  const data = await listTelemetrySessions();
  const { overview, sessions, queue } = data;

  const totals = sessions.reduce(
    (acc, s) => {
      const r = s.reconciliation;
      if (r === null) return acc;
      return {
        matched: acc.matched + r.matched,
        hookOnly: acc.hookOnly + r.hookOnly,
        telemetryOnly: acc.telemetryOnly + r.telemetryOnly,
        awaiting: acc.awaiting + r.awaitingArrival,
        notComparable: acc.notComparable + r.notComparable,
        disagree: acc.disagree + r.matchedWithDisagreement,
      };
    },
    { matched: 0, hookOnly: 0, telemetryOnly: 0, awaiting: 0, notComparable: 0, disagree: 0 },
  );

  return (
    <>
      <Topbar crumb="Agent telemetry" crumbPrefix={dm === 'team-hosted' ? 'coodra · team' : 'coodra · solo'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/06 · AGENT TELEMETRY</div>
            <h1 className="head__title">
              Agent <em>telemetry</em>.
            </h1>
            <p className="head__lede">
              What the agent&apos;s own harness reported, set against what Coodra&apos;s hooks recorded. Observations
              only — a missing row is never proof that something did or did not run.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{fmtInt(overview.totalEvents)} events</strong>
              <br />
              {overview.sessions} sessions
              <br />
              local only · never synced
              <br />
              <Link href="/telemetry/events">Raw events →</Link>
            </div>
          </div>
        </div>

        {data.localOnly ? (
          <div className="empty">
            <strong>
              Telemetry is <em>local</em>.
            </strong>
            <p>
              Native telemetry is stored on the developer machine and is not synced to team Postgres, so this page has
              nothing to show on a hosted team server. Open it from the local dashboard.
            </p>
          </div>
        ) : overview.totalEvents === 0 ? (
          <EmptyState />
        ) : (
          <>
            <Overview data={data} />
            <Verification totals={totals} sessionCount={sessions.length} />
            <SessionsTable rows={sessions} />
          </>
        )}

        <Coverage />

        <footer>
          <p className="muted">
            Fetched {data.fetchedAt} · queue: {queue.pending} pending, {queue.dead} dead-lettered
          </p>
        </footer>
      </section>
    </>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <strong>
        No telemetry <em>received</em>.
      </strong>
      <p>
        Telemetry is opt-in. Start the Coodra daemon with <code>COODRA_TELEMETRY_ENABLED=1</code>, then launch Claude
        Code with <code>CLAUDE_CODE_ENABLE_TELEMETRY=1</code>, <code>OTEL_LOGS_EXPORTER=otlp</code>,{' '}
        <code>OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json</code> and an endpoint of{' '}
        <code>http://127.0.0.1:&lt;port&gt;/telemetry/claude_code/&lt;project-slug&gt;/v1/logs</code>. Full setup is in{' '}
        <code>docs/phase 2 implementation/epic-2-capture-verification-telemetry-and-cost-evidence.md</code>.
      </p>
    </div>
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

function Overview({ data }: { data: Awaited<ReturnType<typeof listTelemetrySessions>> }) {
  const { overview, queue } = data;
  const u = overview.usage;
  const versions =
    overview.versions.length === 0
      ? 'version not reported'
      : overview.versions.map((v) => `${v.harness} ${v.versions.join(', ')}`).join(' · ');
  const unhealthy = queue.dead > 0 || overview.unattachedSessions > 0;
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          <em>Overview</em>
        </h2>
        <span className="card__role">Collection</span>
      </div>
      <div className="stats">
        <Card
          label="Events received"
          value={fmtInt(overview.totalEvents)}
          sub={`${fmtInt(overview.eventsLast24h)} in the last 24 h · last ${
            overview.lastReceivedAtMs === null ? '—' : fmtRelative(new Date(overview.lastReceivedAtMs))
          }`}
        />
        <Card
          label="Harness"
          value={overview.versions.length === 0 ? '—' : (overview.versions[0]?.harness ?? '—')}
          sub={versions}
        />
        <Card
          label="Model requests"
          value={fmtInt(u.requests)}
          sub={`${fmtInt(u.inputTokens)} in · ${fmtInt(u.outputTokens)} out · ${fmtInt(u.cacheReadTokens)} cache read`}
        />
        <Card
          label="Estimated cost"
          value={fmtCostMicros(u.costUsdMicros)}
          sub={
            u.costUsdMicros === null
              ? 'no request reported a cost'
              : `provider estimate on ${u.requestsWithCost} of ${u.requests} requests · not billing`
          }
        />
        <Card
          label="Collection health"
          value={unhealthy ? 'check' : 'ok'}
          warn={unhealthy}
          sub={`${queue.pending} queued · ${queue.dead} dead-lettered · ${overview.unattachedSessions} session(s) without a Run`}
        />
      </div>
    </section>
  );
}

function Verification({
  totals,
  sessionCount,
}: {
  totals: {
    matched: number;
    hookOnly: number;
    telemetryOnly: number;
    awaiting: number;
    notComparable: number;
    disagree: number;
  };
  sessionCount: number;
}) {
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          Capture <em>verification</em>
        </h2>
        <span className="card__role">Tool operations, by native tool-use id</span>
      </div>
      <div className="stats">
        <Card
          label="Matched"
          value={fmtInt(totals.matched)}
          sub={`${totals.disagree} with channel disagreement`}
          warn={totals.disagree > 0}
        />
        <Card
          label="Hook-only"
          value={fmtInt(totals.hookOnly)}
          sub="hooks saw it, telemetry did not"
          warn={totals.hookOnly > 0}
        />
        <Card
          label="Telemetry-only"
          value={fmtInt(totals.telemetryOnly)}
          sub="telemetry saw it, hooks did not"
          warn={totals.telemetryOnly > 0}
        />
        <Card label="Awaiting arrival" value={fmtInt(totals.awaiting)} sub="one side still within the grace window" />
        <Card label="Not comparable" value={fmtInt(totals.notComparable)} sub="no usable id or no telemetry channel" />
      </div>
      <p className="head__lede" style={{ marginBottom: 40 }}>
        Across the {sessionCount} most recent sessions with a Run. Operations are joined only on the native tool-use id;
        session or time proximity never counts as a match.
      </p>
    </section>
  );
}

function SessionsTable({ rows }: { rows: ReadonlyArray<TelemetrySessionRow> }) {
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          <em>Sessions</em>
        </h2>
        <span className="card__role">Attached and unattached</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Session</th>
              <th>Run</th>
              <th className="num">Events</th>
              <th className="num">Matched</th>
              <th className="num">Hook-only</th>
              <th className="num">Telemetry-only</th>
              <th className="num">Tokens in/out</th>
              <th className="num">Est. cost</th>
              <th className="num">Hook errors</th>
              <th>Last event</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const r = s.reconciliation;
              return (
                <tr key={`${s.projectId}:${s.sessionId}:${s.harness}`}>
                  <td>
                    <div className="tbl__title">
                      <Link href={`/telemetry/${encodeURIComponent(s.projectId)}/${encodeURIComponent(s.sessionId)}`}>
                        {shortId(s.sessionId, 12)}
                      </Link>
                    </div>
                    <div className="tbl__mono">
                      {s.harness} · {s.projectSlug}
                    </div>
                  </td>
                  <td>
                    {s.runId === null ? (
                      <span className="badge badge--warn">
                        <span className="badge__dot" />
                        no Run
                      </span>
                    ) : (
                      <Link href={`/runs/${encodeURIComponent(s.runId)}`}>
                        <code>{shortId(s.runId, 14)}</code>
                      </Link>
                    )}
                  </td>
                  <td className="num">{fmtInt(s.events)}</td>
                  <td className="num">{r === null ? '—' : r.matched}</td>
                  <td className="num">{r === null ? '—' : r.hookOnly}</td>
                  <td className="num">{r === null ? '—' : r.telemetryOnly}</td>
                  <td className="num">
                    {fmtInt(s.usage.inputTokens)} / {fmtInt(s.usage.outputTokens)}
                  </td>
                  <td className="num">{fmtCostMicros(s.usage.costUsdMicros)}</td>
                  <td className="num">{s.hookErrors}</td>
                  <td>{fmtClockSec(new Date(s.lastAtMs))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Coverage() {
  return (
    <section>
      <div className="card__head">
        <h2 className="card__title">
          <em>Coverage</em>
        </h2>
        <span className="card__role">What is collected, and what is not verified</span>
      </div>
      <div className="card" style={{ padding: 0, marginBottom: 56 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Harness</th>
              <th>Collected</th>
              <th>Verified on</th>
              <th>Not verified or not collected</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Claude Code</strong>
              </td>
              <td>
                OTLP logs: tool results, API requests and errors, hook execution outcomes and MCP connection status.
                Metadata only — no prompts, tool inputs or outputs, or error text.
              </td>
              <td>2.1.325, 2.1.330</td>
              <td>
                Metrics and traces; end-of-session flush; exporter retry; managed-settings effects. Hook events are per
                hook event, not per Coodra hook; MCP connections do not name the server.
              </td>
            </tr>
            <tr>
              <td>
                <strong>Codex</strong>
              </td>
              <td>
                OTLP logs: tool results (status, duration, call id), model usage per completed response (input, output,
                cached and reasoning tokens), approval decisions and conversation start metadata. Metadata only; Codex
                reports no cost.
              </td>
              <td>0.171.0-alpha.13</td>
              <td>
                CLI inner exec_command, apply_patch and fixture MCP calls have verified matching hook IDs. Outer exec
                wrappers and write_stdin polling have no separate hook and remain not comparable. Other tools require an
                exact ID match or verified coverage. Tool success describes invocation, not shell exit status. Codex
                exports tool arguments and output; Coodra discards them. Desktop export and resumed Run identity are
                verified; native desktop hook capture and shutdown flush remain unverified.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
