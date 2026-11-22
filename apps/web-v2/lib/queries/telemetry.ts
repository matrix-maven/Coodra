import type { DbHandle } from '@coodra/db';
import {
  type HookObservation,
  type ReconcileResult,
  type ReconcileSummary,
  reconcileToolOperations,
  type TelemetryToolResult,
} from '@coodra/shared';

import { createWebDb } from '@/lib/db';

/**
 * `/telemetry` data (COOD-105). Read-only views over `native_telemetry_events`, joined to the hook
 * audit trail in `run_events` only to reconcile tool operations (see
 * `@coodra/shared` `reconcileToolOperations`).
 *
 * Native telemetry is local-only: it is stored in SQLite and never synced, so on a Postgres
 * (team-hosted) handle every function reports `localOnly` instead of an empty result that could be
 * mistaken for "no telemetry was collected".
 */

export interface UsageTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** Sum of provider estimates in micro-USD; null when no request reported one. Never 0 for "unknown". */
  readonly costUsdMicros: number | null;
  readonly requestsWithCost: number;
}

export interface TelemetrySessionRow {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly sessionId: string;
  readonly harness: string;
  readonly runId: string | null;
  readonly events: number;
  readonly firstAtMs: number;
  readonly lastAtMs: number;
  readonly apiErrors: number;
  readonly hookErrors: number;
  readonly hookBlocking: number;
  readonly usage: UsageTotals;
  /** Null when the session has no Run (nothing to compare against). */
  readonly reconciliation: ReconcileSummary | null;
}

export interface TelemetryOverview {
  readonly totalEvents: number;
  readonly eventsLast24h: number;
  /** Receipt time of the newest event, or null when nothing has ever been received. */
  readonly lastReceivedAtMs: number | null;
  readonly versions: ReadonlyArray<{ readonly harness: string; readonly versions: ReadonlyArray<string> }>;
  readonly usage: UsageTotals;
  readonly sessions: number;
  /** Sessions with no Run: evidence the hooks never registered (or have not yet). */
  readonly unattachedSessions: number;
  readonly unattachedEvents: number;
}

export interface TelemetrySessionList {
  readonly localOnly: boolean;
  readonly overview: TelemetryOverview;
  readonly sessions: ReadonlyArray<TelemetrySessionRow>;
  readonly queue: QueueState;
  readonly fetchedAt: string;
}

export interface QueueState {
  readonly pending: number;
  /** Jobs that exhausted retries or failed permanently and are kept for inspection. */
  readonly dead: number;
  readonly oldestPendingAgeSec: number | null;
}

export interface TelemetryEventRow {
  readonly id: string;
  readonly eventName: string;
  readonly toolName: string | null;
  readonly toolUseId: string | null;
  readonly success: boolean | null;
  readonly model: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsdMicros: number | null;
  readonly costKind: string;
  readonly hookEvent: string | null;
  readonly connectionStatus: string | null;
  readonly attached: boolean;
  readonly sourceAtMs: number;
  readonly receivedAtMs: number;
}

export interface ModelUsage extends UsageTotals {
  readonly model: string;
}

export interface HookHealthRow {
  readonly hookEvent: string;
  readonly executions: number;
  readonly hooks: number;
  readonly succeeded: number;
  readonly blocking: number;
  readonly errors: number;
  readonly cancelled: number;
  readonly avgMs: number | null;
  readonly maxMs: number | null;
}

export interface McpConnectionRow {
  readonly status: string;
  readonly transportType: string;
  readonly serverScope: string;
  readonly count: number;
  readonly maxMs: number | null;
}

export interface TelemetrySessionDetail {
  readonly localOnly: boolean;
  readonly found: boolean;
  readonly projectId: string;
  readonly projectSlug: string | null;
  readonly sessionId: string;
  readonly harness: string | null;
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly startedAtMs: number;
    readonly endedAtMs: number | null;
  } | null;
  readonly usage: UsageTotals;
  readonly usageByModel: ReadonlyArray<ModelUsage>;
  readonly hookHealth: ReadonlyArray<HookHealthRow>;
  readonly mcpConnections: ReadonlyArray<McpConnectionRow>;
  readonly apiErrors: number;
  readonly reconciliation: ReconcileResult;
  readonly queue: QueueState;
  readonly events: ReadonlyArray<TelemetryEventRow>;
  readonly eventsTotal: number;
  readonly firstAtMs: number | null;
  readonly lastAtMs: number | null;
  readonly fetchedAt: string;
}

const EMPTY_USAGE: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsdMicros: null,
  requestsWithCost: 0,
};
const EMPTY_OVERVIEW: TelemetryOverview = {
  totalEvents: 0,
  eventsLast24h: 0,
  lastReceivedAtMs: null,
  versions: [],
  usage: EMPTY_USAGE,
  sessions: 0,
  unattachedSessions: 0,
  unattachedEvents: 0,
};
const EMPTY_QUEUE: QueueState = { pending: 0, dead: 0, oldestPendingAgeSec: null };
const EVENTS_SHOWN = 300;
/** Hook rows are read per run to reconcile; bound it so one enormous Run cannot stall the page. */
const HOOK_ROW_LIMIT = 50_000;

type SqliteHandle = Extract<DbHandle, { kind: 'sqlite' }>;

const n = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));
const nOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function usageFrom(row: Record<string, unknown>): UsageTotals {
  const withCost = n(row.cost_rows);
  return {
    requests: n(row.requests),
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
    cacheReadTokens: n(row.cache_read_tokens),
    cacheCreationTokens: n(row.cache_creation_tokens),
    // "unavailable" stays null: summing nothing would render a misleading $0.
    costUsdMicros: withCost > 0 ? n(row.cost_micros) : null,
    requestsWithCost: withCost,
  };
}

const USAGE_SELECT = `
  sum(event_name = 'claude_code.api_request') AS requests,
  sum(CASE WHEN event_name = 'claude_code.api_request' THEN coalesce(input_tokens, 0) END) AS input_tokens,
  sum(CASE WHEN event_name = 'claude_code.api_request' THEN coalesce(output_tokens, 0) END) AS output_tokens,
  sum(CASE WHEN event_name = 'claude_code.api_request' THEN coalesce(cache_read_tokens, 0) END) AS cache_read_tokens,
  sum(CASE WHEN event_name = 'claude_code.api_request' THEN coalesce(cache_creation_tokens, 0) END) AS cache_creation_tokens,
  sum(CASE WHEN event_name = 'claude_code.api_request' AND cost_kind = 'provider_estimate' AND cost_usd_micros IS NOT NULL
        THEN 1 ELSE 0 END) AS cost_rows,
  sum(CASE WHEN event_name = 'claude_code.api_request' AND cost_kind = 'provider_estimate' THEN cost_usd_micros END) AS cost_micros`;

function queueState(handle: SqliteHandle, projectId: string, sessionId: string | null): QueueState {
  const where = sessionId === null ? '' : "AND json_extract(payload, '$.sessionId') = ?";
  const params = sessionId === null ? [projectId, projectId] : [projectId, projectId, sessionId];
  const rows = handle.raw
    .prepare(
      `SELECT status, count(*) AS c, min(created_at) AS oldest FROM pending_jobs
        WHERE id GLOB 'native_telemetry_*' AND (project_id = ? OR json_extract(payload, '$.projectId') = ?) ${where}
        GROUP BY status`,
    )
    .all(...params) as Array<{ status: string; c: number; oldest: number | null }>;
  let pending = 0;
  let dead = 0;
  let oldest: number | null = null;
  for (const row of rows) {
    if (row.status === 'dead') dead += row.c;
    else {
      pending += row.c;
      if (row.oldest !== null) oldest = oldest === null ? row.oldest : Math.min(oldest, row.oldest);
    }
  }
  return {
    pending,
    dead,
    oldestPendingAgeSec: oldest === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - oldest),
  };
}

function loadHooks(handle: SqliteHandle, runId: string): HookObservation[] {
  const rows = handle.raw
    .prepare(
      `SELECT id, phase, tool_name, tool_use_id, outcome, created_at FROM run_events
        WHERE run_id = ? AND phase IN ('pre', 'post') ORDER BY created_at LIMIT ?`,
    )
    .all(runId, HOOK_ROW_LIMIT) as Array<{
    id: string;
    phase: 'pre' | 'post';
    tool_name: string;
    tool_use_id: string;
    outcome: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    rowId: r.id,
    phase: r.phase,
    toolName: r.tool_name,
    toolUseId: r.tool_use_id,
    outcome: r.outcome,
    atMs: r.created_at * 1000,
  }));
}

function loadToolResults(handle: SqliteHandle, projectId: string, sessionId: string): TelemetryToolResult[] {
  const rows = handle.raw
    .prepare(
      `SELECT id, tool_use_id, tool_name, success, duration_ms, source_time_ms, received_at
         FROM native_telemetry_events
        WHERE project_id = ? AND session_id = ? AND event_name = 'claude_code.tool_result'`,
    )
    .all(projectId, sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    evidenceId: String(r.id),
    toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null,
    toolName: typeof r.tool_name === 'string' ? r.tool_name : null,
    success: r.success === null || r.success === undefined ? null : Number(r.success) === 1,
    durationMs: nOrNull(r.duration_ms),
    sourceMs: n(r.source_time_ms),
    receivedMs: n(r.received_at) * 1000,
  }));
}

function reconcileSession(
  handle: SqliteHandle,
  args: {
    projectId: string;
    sessionId: string;
    harness: string;
    runId: string | null;
    runEnded: boolean;
    eventCount: number;
    nowMs: number;
  },
): ReconcileResult {
  return reconcileToolOperations({
    harness: args.harness,
    hooks: args.runId === null ? [] : loadHooks(handle, args.runId),
    telemetry: loadToolResults(handle, args.projectId, args.sessionId),
    telemetryEventCount: args.eventCount,
    hasRun: args.runId !== null,
    runEnded: args.runEnded,
    nowMs: args.nowMs,
  });
}

function runFor(
  handle: SqliteHandle,
  projectId: string,
  sessionId: string,
  harness: string,
): { id: string; status: string; started: number; ended: number | null } | null {
  const row = handle.raw
    .prepare(
      'SELECT id, status, started_at, ended_at FROM runs WHERE project_id = ? AND session_id = ? AND agent_type = ?',
    )
    .get(projectId, sessionId, harness) as
    | { id: string; status: string; started_at: number; ended_at: number | null }
    | undefined;
  return row === undefined ? null : { id: row.id, status: row.status, started: row.started_at, ended: row.ended_at };
}

export async function listTelemetrySessions(db?: DbHandle, limit = 40): Promise<TelemetrySessionList> {
  const handle = db ?? createWebDb();
  const fetchedAt = new Date().toISOString();
  if (handle.kind !== 'sqlite') {
    return { localOnly: true, overview: EMPTY_OVERVIEW, sessions: [], queue: EMPTY_QUEUE, fetchedAt };
  }
  const rows = handle.raw
    .prepare(
      `SELECT t.project_id, p.slug AS project_slug, p.name AS project_name, t.session_id, t.harness,
              max(t.run_id) AS run_id, count(*) AS events,
              min(t.source_time_ms) AS first_ms, max(t.source_time_ms) AS last_ms,
              sum(t.event_name = 'claude_code.api_error') AS api_errors,
              sum(coalesce(t.hook_error_count, 0)) AS hook_errors,
              sum(coalesce(t.hook_blocking_count, 0)) AS hook_blocking,
              ${USAGE_SELECT}
         FROM native_telemetry_events t JOIN projects p ON p.id = t.project_id
        GROUP BY t.project_id, t.session_id, t.harness
        ORDER BY last_ms DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;

  const nowMs = Date.now();
  const sessions: TelemetrySessionRow[] = rows.map((r) => {
    const projectId = String(r.project_id);
    const sessionId = String(r.session_id);
    const harness = String(r.harness);
    const run = runFor(handle, projectId, sessionId, harness);
    const reconciliation =
      run === null
        ? null
        : reconcileSession(handle, {
            projectId,
            sessionId,
            harness,
            runId: run.id,
            runEnded: run.status !== 'in_progress',
            eventCount: n(r.events),
            nowMs,
          }).summary;
    return {
      projectId,
      projectSlug: String(r.project_slug),
      projectName: String(r.project_name),
      sessionId,
      harness,
      runId: run?.id ?? null,
      events: n(r.events),
      firstAtMs: n(r.first_ms),
      lastAtMs: n(r.last_ms),
      apiErrors: n(r.api_errors),
      hookErrors: n(r.hook_errors),
      hookBlocking: n(r.hook_blocking),
      usage: usageFrom(r),
      reconciliation,
    };
  });

  const queueRows = handle.raw
    .prepare(
      `SELECT status, count(*) AS c, min(created_at) AS oldest FROM pending_jobs
        WHERE id GLOB 'native_telemetry_*' GROUP BY status`,
    )
    .all() as Array<{ status: string; c: number; oldest: number | null }>;
  let pending = 0;
  let dead = 0;
  let oldest: number | null = null;
  for (const q of queueRows) {
    if (q.status === 'dead') dead += q.c;
    else {
      pending += q.c;
      if (q.oldest !== null) oldest = oldest === null ? q.oldest : Math.min(oldest, q.oldest);
    }
  }
  const head = handle.raw
    .prepare(
      `SELECT count(*) AS total, sum(received_at >= ?) AS recent, max(received_at) AS last_received,
              sum(run_id IS NULL) AS unattached_events, ${USAGE_SELECT}
         FROM native_telemetry_events`,
    )
    .get(Math.floor(nowMs / 1000) - 86_400) as Record<string, unknown>;
  const versionRows = handle.raw
    .prepare(
      `SELECT harness, app_version FROM native_telemetry_events WHERE app_version IS NOT NULL
        GROUP BY harness, app_version ORDER BY harness, app_version`,
    )
    .all() as Array<{ harness: string; app_version: string }>;
  const versionMap = new Map<string, string[]>();
  for (const v of versionRows) versionMap.set(v.harness, [...(versionMap.get(v.harness) ?? []), v.app_version]);
  const sessionCounts = handle.raw
    .prepare(
      `SELECT count(*) AS sessions, sum(unattached) AS unattached FROM (
         SELECT project_id, session_id, harness, max(run_id IS NULL) AS unattached
           FROM native_telemetry_events GROUP BY project_id, session_id, harness)`,
    )
    .get() as { sessions: number; unattached: number | null };
  const overview: TelemetryOverview = {
    totalEvents: n(head.total),
    eventsLast24h: n(head.recent),
    lastReceivedAtMs: head.last_received === null ? null : n(head.last_received) * 1000,
    versions: [...versionMap.entries()].map(([harness, versions]) => ({ harness, versions })),
    usage: usageFrom(head),
    sessions: n(sessionCounts.sessions),
    unattachedSessions: n(sessionCounts.unattached),
    unattachedEvents: n(head.unattached_events),
  };
  return {
    localOnly: false,
    overview,
    sessions,
    queue: {
      pending,
      dead,
      oldestPendingAgeSec: oldest === null ? null : Math.max(0, Math.floor(nowMs / 1000) - oldest),
    },
    fetchedAt,
  };
}

export async function getTelemetrySession(
  projectId: string,
  sessionId: string,
  db?: DbHandle,
): Promise<TelemetrySessionDetail> {
  const handle = db ?? createWebDb();
  const fetchedAt = new Date().toISOString();
  const nowMs = Date.now();
  const empty = (localOnly: boolean): TelemetrySessionDetail => ({
    localOnly,
    found: false,
    projectId,
    projectSlug: null,
    sessionId,
    harness: null,
    run: null,
    usage: EMPTY_USAGE,
    usageByModel: [],
    hookHealth: [],
    mcpConnections: [],
    apiErrors: 0,
    reconciliation: reconcileToolOperations({
      harness: 'claude_code',
      hooks: [],
      telemetry: [],
      telemetryEventCount: 0,
      hasRun: false,
      runEnded: false,
      nowMs,
    }),
    queue: EMPTY_QUEUE,
    events: [],
    eventsTotal: 0,
    firstAtMs: null,
    lastAtMs: null,
    fetchedAt,
  });
  if (handle.kind !== 'sqlite') return empty(true);

  const head = handle.raw
    .prepare(
      `SELECT t.harness, count(*) AS events, min(t.source_time_ms) AS first_ms, max(t.source_time_ms) AS last_ms,
              sum(t.event_name = 'claude_code.api_error') AS api_errors
         FROM native_telemetry_events t WHERE t.project_id = ? AND t.session_id = ? GROUP BY t.harness`,
    )
    .get(projectId, sessionId) as Record<string, unknown> | undefined;
  const slug = handle.raw.prepare('SELECT slug FROM projects WHERE id = ?').get(projectId) as
    | { slug: string }
    | undefined;
  if (head === undefined) {
    return { ...empty(false), projectSlug: slug?.slug ?? null, queue: queueState(handle, projectId, sessionId) };
  }
  const harness = String(head.harness);
  const eventCount = n(head.events);
  const run = runFor(handle, projectId, sessionId, harness);

  const usage = usageFrom(
    handle.raw
      .prepare(`SELECT ${USAGE_SELECT} FROM native_telemetry_events WHERE project_id = ? AND session_id = ?`)
      .get(projectId, sessionId) as Record<string, unknown>,
  );
  const usageByModel = (
    handle.raw
      .prepare(
        `SELECT model, ${USAGE_SELECT} FROM native_telemetry_events
          WHERE project_id = ? AND session_id = ? AND event_name = 'claude_code.api_request' AND model IS NOT NULL
          GROUP BY model ORDER BY requests DESC`,
      )
      .all(projectId, sessionId) as Array<Record<string, unknown>>
  ).map((r) => ({ model: String(r.model), ...usageFrom(r) }));

  const hookHealth = (
    handle.raw
      .prepare(
        `SELECT hook_event, count(*) AS executions, sum(coalesce(hook_count, 0)) AS hooks,
                sum(coalesce(hook_success_count, 0)) AS succeeded, sum(coalesce(hook_blocking_count, 0)) AS blocking,
                sum(coalesce(hook_error_count, 0)) AS errors, sum(coalesce(hook_cancelled_count, 0)) AS cancelled,
                avg(duration_ms) AS avg_ms, max(duration_ms) AS max_ms
           FROM native_telemetry_events
          WHERE project_id = ? AND session_id = ? AND event_name = 'claude_code.hook_execution_complete'
            AND hook_event IS NOT NULL
          GROUP BY hook_event ORDER BY executions DESC`,
      )
      .all(projectId, sessionId) as Array<Record<string, unknown>>
  ).map((r) => ({
    hookEvent: String(r.hook_event),
    executions: n(r.executions),
    hooks: n(r.hooks),
    succeeded: n(r.succeeded),
    blocking: n(r.blocking),
    errors: n(r.errors),
    cancelled: n(r.cancelled),
    avgMs: nOrNull(r.avg_ms),
    maxMs: nOrNull(r.max_ms),
  }));

  const mcpConnections = (
    handle.raw
      .prepare(
        `SELECT coalesce(connection_status, 'unknown') AS status, coalesce(transport_type, 'unknown') AS transport,
                coalesce(server_scope, 'unknown') AS scope, count(*) AS c, max(duration_ms) AS max_ms
           FROM native_telemetry_events
          WHERE project_id = ? AND session_id = ? AND event_name = 'claude_code.mcp_server_connection'
          GROUP BY 1, 2, 3 ORDER BY c DESC`,
      )
      .all(projectId, sessionId) as Array<Record<string, unknown>>
  ).map((r) => ({
    status: String(r.status),
    transportType: String(r.transport),
    serverScope: String(r.scope),
    count: n(r.c),
    maxMs: nOrNull(r.max_ms),
  }));

  const events = (
    handle.raw
      .prepare(
        `SELECT id, event_name, tool_name, tool_use_id, success, model, duration_ms, input_tokens, output_tokens,
                cost_usd_micros, cost_kind, hook_event, connection_status, run_id, source_time_ms, received_at
           FROM native_telemetry_events WHERE project_id = ? AND session_id = ?
          ORDER BY source_time_ms DESC LIMIT ?`,
      )
      .all(projectId, sessionId, EVENTS_SHOWN) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: String(r.id),
    eventName: String(r.event_name),
    toolName: typeof r.tool_name === 'string' ? r.tool_name : null,
    toolUseId: typeof r.tool_use_id === 'string' ? r.tool_use_id : null,
    success: r.success === null || r.success === undefined ? null : Number(r.success) === 1,
    model: typeof r.model === 'string' ? r.model : null,
    durationMs: nOrNull(r.duration_ms),
    inputTokens: nOrNull(r.input_tokens),
    outputTokens: nOrNull(r.output_tokens),
    costUsdMicros: nOrNull(r.cost_usd_micros),
    costKind: String(r.cost_kind),
    hookEvent: typeof r.hook_event === 'string' ? r.hook_event : null,
    connectionStatus: typeof r.connection_status === 'string' ? r.connection_status : null,
    attached: r.run_id !== null && r.run_id !== undefined,
    sourceAtMs: n(r.source_time_ms),
    receivedAtMs: n(r.received_at) * 1000,
  }));

  return {
    localOnly: false,
    found: true,
    projectId,
    projectSlug: slug?.slug ?? null,
    sessionId,
    harness,
    run:
      run === null
        ? null
        : {
            id: run.id,
            status: run.status,
            startedAtMs: run.started * 1000,
            endedAtMs: run.ended === null ? null : run.ended * 1000,
          },
    usage,
    usageByModel,
    hookHealth,
    mcpConnections,
    apiErrors: n(head.api_errors),
    reconciliation: reconcileSession(handle, {
      projectId,
      sessionId,
      harness,
      runId: run?.id ?? null,
      runEnded: run !== null && run.status !== 'in_progress',
      eventCount,
      nowMs,
    }),
    queue: queueState(handle, projectId, sessionId),
    events,
    eventsTotal: eventCount,
    firstAtMs: nOrNull(head.first_ms),
    lastAtMs: nOrNull(head.last_ms),
    fetchedAt,
  };
}

/* -------------------------------------------------------------------------------------------- */
/*  Raw events explorer                                                                         */
/* -------------------------------------------------------------------------------------------- */

export const EVENT_RANGES = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
} as const;
export type EventRange = keyof typeof EVENT_RANGES | 'all';

export interface TelemetryEventFilters {
  /** Exact event name, e.g. `claude_code.tool_result`. */
  readonly event?: string;
  readonly sessionId?: string;
  /** Matches tool name, native tool-use id, request id, model, hook event or id prefix (substring). */
  readonly q?: string;
  /** Failures only: tool failed, API error, hook error/block/cancel, or MCP connection not connected. */
  readonly problemsOnly?: boolean;
  readonly range?: EventRange;
  readonly limit?: number;
}

export interface RawTelemetryEvent {
  readonly id: string;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly runId: string | null;
  readonly harness: string;
  readonly source: string;
  readonly eventName: string;
  readonly sessionId: string;
  readonly sourceTimeUnixNano: string;
  readonly sourceAtMs: number;
  readonly receivedAtMs: number;
  /** Receipt time minus source time. Large values mean batching, retry or clock skew. */
  readonly lagMs: number;
  readonly costKind: string;
  readonly contentPolicy: string;
  /** Every typed column that has a value, by column name. */
  readonly columns: Readonly<Record<string, string | number | boolean>>;
  /** The full allowlisted attribute set as stored. */
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface TelemetryEventsResult {
  readonly localOnly: boolean;
  readonly events: ReadonlyArray<RawTelemetryEvent>;
  /** Rows matching the filters (not just the page shown). */
  readonly matched: number;
  readonly limit: number;
  /** Event names present in the table, with counts, for the filter. */
  readonly eventNames: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly fetchedAt: string;
}

const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 500;
const PROBLEM_SQL = `(
  success = 0
  OR event_name = 'claude_code.api_error'
  OR coalesce(hook_error_count, 0) > 0 OR coalesce(hook_blocking_count, 0) > 0 OR coalesce(hook_cancelled_count, 0) > 0
  OR (event_name = 'claude_code.mcp_server_connection' AND coalesce(connection_status, '') NOT IN ('connected'))
)`;

/** Columns surfaced in the detail view, as [sql column, label]. Order is display order. */
const DETAIL_COLUMNS = [
  'tool_name',
  'tool_use_id',
  'request_id',
  'client_request_id',
  'prompt_id',
  'agent_id',
  'parent_agent_id',
  'model',
  'success',
  'event_sequence',
  'duration_ms',
  'status_code',
  'attempt',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'tool_input_size_bytes',
  'tool_result_size_bytes',
  'hook_event',
  'hook_name',
  'hook_count',
  'hook_success_count',
  'hook_blocking_count',
  'hook_error_count',
  'hook_cancelled_count',
  'connection_status',
  'transport_type',
  'server_scope',
  'plugin_id_hash',
  'cost_usd_micros',
  'app_version',
] as const;

export async function listTelemetryEvents(
  filters: TelemetryEventFilters = {},
  db?: DbHandle,
): Promise<TelemetryEventsResult> {
  const handle = db ?? createWebDb();
  const fetchedAt = new Date().toISOString();
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? EVENTS_DEFAULT_LIMIT), 1), EVENTS_MAX_LIMIT);
  if (handle.kind !== 'sqlite') {
    return { localOnly: true, events: [], matched: 0, limit, eventNames: [], fetchedAt };
  }

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filters.event !== undefined && filters.event !== '') {
    where.push('t.event_name = ?');
    params.push(filters.event);
  }
  if (filters.sessionId !== undefined && filters.sessionId !== '') {
    where.push('t.session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.q !== undefined && filters.q.trim() !== '') {
    // Escape LIKE wildcards so the box searches literally.
    const like = `%${filters.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(t.tool_name LIKE ? ESCAPE '\\' OR t.tool_use_id LIKE ? ESCAPE '\\' OR t.request_id LIKE ? ESCAPE '\\'
        OR t.model LIKE ? ESCAPE '\\' OR t.hook_event LIKE ? ESCAPE '\\' OR t.id LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like, like);
  }
  if (filters.problemsOnly === true) where.push(PROBLEM_SQL);
  const range = filters.range ?? 'all';
  if (range !== 'all') {
    where.push('t.source_time_ms >= ?');
    params.push(Date.now() - EVENT_RANGES[range]);
  }
  const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;

  const matched = n(
    (
      handle.raw.prepare(`SELECT count(*) AS c FROM native_telemetry_events t ${clause}`).get(...params) as {
        c: number;
      }
    ).c,
  );
  const rows = handle.raw
    .prepare(
      `SELECT t.*, p.slug AS project_slug FROM native_telemetry_events t JOIN projects p ON p.id = t.project_id
        ${clause} ORDER BY t.source_time_ms DESC, t.id LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  const events: RawTelemetryEvent[] = rows.map((r) => {
    const columns: Record<string, string | number | boolean> = {};
    for (const key of DETAIL_COLUMNS) {
      const v = r[key];
      if (v === null || v === undefined) continue;
      columns[key] = key === 'success' ? Number(v) === 1 : (v as string | number);
    }
    let attributes: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(r.attributes_json ?? '{}'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        attributes = parsed as Record<string, unknown>;
      }
    } catch {
      attributes = { _unparseable_attributes_json: String(r.attributes_json ?? '') };
    }
    const sourceAtMs = n(r.source_time_ms);
    const receivedAtMs = n(r.received_at) * 1000;
    return {
      id: String(r.id),
      projectId: String(r.project_id),
      projectSlug: String(r.project_slug),
      runId: typeof r.run_id === 'string' ? r.run_id : null,
      harness: String(r.harness),
      source: String(r.source),
      eventName: String(r.event_name),
      sessionId: String(r.session_id),
      sourceTimeUnixNano: String(r.source_time_unix_nano),
      sourceAtMs,
      receivedAtMs,
      lagMs: receivedAtMs - sourceAtMs,
      costKind: String(r.cost_kind),
      contentPolicy: String(r.content_policy),
      columns,
      attributes,
    };
  });

  const eventNames = (
    handle.raw
      .prepare(
        'SELECT event_name AS name, count(*) AS c FROM native_telemetry_events GROUP BY event_name ORDER BY c DESC',
      )
      .all() as Array<{ name: string; c: number }>
  ).map((e) => ({ name: e.name, count: e.c }));

  return { localOnly: false, events, matched, limit, eventNames, fetchedAt };
}
