import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fmtClockSec } from '@/lib/format';
import {
  EVENT_RANGES,
  type EventRange,
  listTelemetryEvents,
  type RawTelemetryEvent,
  type TelemetryEventFilters,
} from '@/lib/queries/telemetry';
import { fmtCostMicros, fmtInt, fmtMs, shortId } from '@/lib/telemetry-format';

import { LiveTail } from './LiveTail';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function parseFilters(sp: Search): TelemetryEventFilters & { live: boolean } {
  const range = one(sp.range);
  const limit = Number.parseInt(one(sp.limit) ?? '', 10);
  return {
    ...(one(sp.event) ? { event: one(sp.event) as string } : {}),
    ...(one(sp.session) ? { sessionId: one(sp.session) as string } : {}),
    ...(one(sp.q) ? { q: one(sp.q) as string } : {}),
    problemsOnly: one(sp.problems) === '1',
    range: range === 'all' || (range !== undefined && range in EVENT_RANGES) ? (range as EventRange) : 'all',
    ...(Number.isFinite(limit) ? { limit } : {}),
    live: one(sp.live) === '1',
  };
}

function href(f: TelemetryEventFilters & { live: boolean }, over: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  const set = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== '') q.set(k, v);
  };
  set('event', f.event);
  set('session', f.sessionId);
  set('q', f.q);
  if (f.problemsOnly === true) q.set('problems', '1');
  if (f.range !== undefined && f.range !== 'all') q.set('range', f.range);
  if (f.limit !== undefined) q.set('limit', String(f.limit));
  if (f.live) q.set('live', '1');
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s === '' ? '/telemetry/events' : `/telemetry/events?${s}`;
}

export default async function RawTelemetryEventsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const dm = resolveDeploymentMode();
  const data = await listTelemetryEvents(filters);
  const shown = data.events.length;

  return (
    <>
      <Topbar crumb="Agent telemetry" crumbPrefix={dm === 'team-hosted' ? 'coodra · team' : 'coodra · solo'} />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">
              <Link href="/telemetry">/06 · AGENT TELEMETRY</Link> · RAW EVENTS
            </div>
            <h1 className="head__title">
              Raw <em>events</em>.
            </h1>
            <p className="head__lede">
              Every accepted event, newest first, with the stored columns and the allowlisted attributes exactly as
              received. Prompts, tool inputs and outputs and error text are never stored, so they cannot appear here.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{fmtInt(data.matched)} matching</strong>
              <br />
              showing {shown}
              <br />
              <LiveTail
                enabled={filters.live}
                onHref={href(filters, { live: '1' })}
                offHref={href(filters, { live: undefined })}
              />
            </div>
          </div>
        </div>

        {data.localOnly ? (
          <div className="empty">
            <strong>
              Telemetry is <em>local</em>.
            </strong>
            <p>Native telemetry is not synced to team Postgres; open this page from the local dashboard.</p>
          </div>
        ) : (
          <>
            <Filters filters={filters} names={data.eventNames} />
            {shown === 0 ? (
              <div className="empty">
                <strong>
                  No events <em>match</em>.
                </strong>
                <p>
                  {data.eventNames.length === 0
                    ? 'No telemetry has been received yet. See Agent telemetry for setup.'
                    : 'Loosen the filters, or widen the time range.'}
                </p>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8, marginBottom: 32 }}>
                {data.events.map((e) => (
                  <EventRow key={e.id} e={e} />
                ))}
              </div>
            )}
            {data.matched > shown ? (
              <p>
                Showing the newest {shown} of {fmtInt(data.matched)}.{' '}
                <Link href={href(filters, { limit: String(Math.min(data.limit * 2, 500)) })}>Show more</Link>
                {data.limit >= 500 ? ' (500 is the maximum per page; narrow the filters to see older events)' : ''}
              </p>
            ) : null}
          </>
        )}
        <footer>
          <p className="muted">Fetched {data.fetchedAt}</p>
        </footer>
      </section>
    </>
  );
}

function Filters({
  filters,
  names,
}: {
  filters: TelemetryEventFilters & { live: boolean };
  names: ReadonlyArray<{ name: string; count: number }>;
}) {
  const field = { padding: '6px 8px', background: 'transparent', color: 'inherit', border: '1px solid currentColor' };
  return (
    <form
      method="get"
      action="/telemetry/events"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 20 }}
    >
      <select name="event" defaultValue={filters.event ?? ''} style={field} aria-label="Event type">
        <option value="">all events</option>
        {names.map((n) => (
          <option key={n.name} value={n.name}>
            {n.name.replace('claude_code.', '')} ({n.count})
          </option>
        ))}
      </select>
      <select name="range" defaultValue={filters.range ?? 'all'} style={field} aria-label="Time range">
        <option value="all">all time</option>
        <option value="15m">last 15 min</option>
        <option value="1h">last hour</option>
        <option value="24h">last 24 h</option>
        <option value="7d">last 7 days</option>
      </select>
      <input
        name="q"
        defaultValue={filters.q ?? ''}
        placeholder="tool, tool-use id, request id, model…"
        style={{ ...field, minWidth: 280 }}
        aria-label="Search"
      />
      <input
        name="session"
        defaultValue={filters.sessionId ?? ''}
        placeholder="session id"
        style={{ ...field, minWidth: 220 }}
        aria-label="Session id"
      />
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" name="problems" value="1" defaultChecked={filters.problemsOnly === true} /> problems only
      </label>
      {filters.live ? <input type="hidden" name="live" value="1" /> : null}
      <button type="submit" className="badge" style={{ cursor: 'pointer' }}>
        Apply
      </button>
      <Link href="/telemetry/events">Reset</Link>
    </form>
  );
}

function summary(e: RawTelemetryEvent): string {
  const c = e.columns;
  const parts: Array<string | null> = [
    typeof c.tool_name === 'string' ? c.tool_name : null,
    c.success === undefined ? null : c.success === true ? 'success' : 'failed',
    typeof c.model === 'string' ? c.model : null,
    typeof c.hook_event === 'string'
      ? `${c.hook_event} · ${c.hook_count ?? '?'} hook(s), ${c.hook_error_count ?? 0} error(s)`
      : null,
    typeof c.connection_status === 'string'
      ? `${c.connection_status} · ${c.transport_type ?? '?'} · ${c.server_scope ?? '?'}`
      : null,
    typeof c.input_tokens === 'number' ? `${fmtInt(c.input_tokens)}/${fmtInt(Number(c.output_tokens ?? 0))} tok` : null,
    e.costKind === 'provider_estimate' && typeof c.cost_usd_micros === 'number'
      ? fmtCostMicros(c.cost_usd_micros)
      : null,
    typeof c.status_code === 'number' ? `HTTP ${c.status_code}` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(' · ') || '—';
}

function isProblem(e: RawTelemetryEvent): boolean {
  const c = e.columns;
  return (
    c.success === false ||
    e.eventName === 'claude_code.api_error' ||
    Number(c.hook_error_count ?? 0) > 0 ||
    Number(c.hook_blocking_count ?? 0) > 0 ||
    Number(c.hook_cancelled_count ?? 0) > 0 ||
    (e.eventName === 'claude_code.mcp_server_connection' && c.connection_status !== 'connected')
  );
}

function EventRow({ e }: { e: RawTelemetryEvent }) {
  const duration = typeof e.columns.duration_ms === 'number' ? e.columns.duration_ms : null;
  return (
    <details className="card" style={{ padding: 0 }}>
      <summary
        style={{
          cursor: 'pointer',
          padding: '10px 14px',
          display: 'flex',
          gap: 14,
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <span className="tbl__mono">{fmtClockSec(new Date(e.sourceAtMs))}</span>
        <span className={isProblem(e) ? 'badge badge--warn' : 'badge'}>
          <span className="badge__dot" />
          {e.eventName.replace('claude_code.', '')}
        </span>
        <span style={{ flex: 1, minWidth: 220 }}>{summary(e)}</span>
        {duration === null ? null : <span className="tbl__mono">{fmtMs(duration)}</span>}
        <span className="tbl__mono">{shortId(e.sessionId, 8)}</span>
        {e.runId === null ? <span className="badge badge--warn">unattached</span> : null}
      </summary>
      <div style={{ padding: '4px 14px 14px', display: 'grid', gap: 14 }}>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: 0 }}>
          <Item k="row id" v={e.id} mono />
          <Item k="event" v={e.eventName} mono />
          <Item k="harness / source" v={`${e.harness} / ${e.source}`} mono />
          <Item k="project" v={e.projectSlug} mono />
          <dt className="muted">session</dt>
          <dd style={{ margin: 0 }}>
            <Link href={`/telemetry/${encodeURIComponent(e.projectId)}/${encodeURIComponent(e.sessionId)}`}>
              <code>{e.sessionId}</code>
            </Link>
          </dd>
          <dt className="muted">run</dt>
          <dd style={{ margin: 0 }}>
            {e.runId === null ? (
              'none — unattached (expires 24 h after receipt unless a Run appears)'
            ) : (
              <Link href={`/runs/${encodeURIComponent(e.runId)}`}>
                <code>{e.runId}</code>
              </Link>
            )}
          </dd>
          <Item k="source time" v={`${new Date(e.sourceAtMs).toISOString()}  (${e.sourceTimeUnixNano} ns)`} mono />
          <Item
            k="received"
            v={`${new Date(e.receivedAtMs).toISOString()}  (+${fmtMs(Math.max(0, e.lagMs))} after source)`}
            mono
          />
          <Item
            k="cost"
            v={`${e.costKind}${e.costKind === 'provider_estimate' ? ' — provider estimate, not billing' : ' — unavailable'}`}
          />
          <Item k="content" v={e.contentPolicy} />
        </dl>
        <div>
          <div className="stat__label">Stored columns</div>
          {Object.keys(e.columns).length === 0 ? (
            <p className="muted">No typed values for this event.</p>
          ) : (
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 16px', margin: '6px 0 0' }}>
              {Object.entries(e.columns).map(([k, v]) => (
                <Item key={k} k={k} v={String(v)} mono />
              ))}
            </dl>
          )}
        </div>
        <div>
          <div className="stat__label">Attributes (allowlisted, as stored)</div>
          <pre className="tbl__mono" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(e.attributes, null, 2)}
          </pre>
        </div>
      </div>
    </details>
  );
}

function Item({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="muted">{k}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }} className={mono === true ? 'tbl__mono' : undefined}>
        {v}
      </dd>
    </>
  );
}
