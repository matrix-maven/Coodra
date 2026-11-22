import { createHash } from 'node:crypto';
import type { NativeTelemetryPayloadV1 } from '@coodra/cli/lib/outbox';
import { type DbHandle, lookupProjectBySlug, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

/** Provider-neutral storage envelope. Provider adapters must establish their own coverage. */
export interface NativeTelemetryObservation {
  readonly version: 1;
  readonly harness: 'claude_code' | 'codex';
  readonly source: 'otlp_logs';
  readonly eventName: string;
  readonly sourceTimeUnixNano: string;
  readonly receivedAt: string;
  readonly projectId: string;
  /** NULL when no Run exists for the native session yet (unattached evidence). */
  readonly runId: string | null;
  readonly sessionId: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly content: 'excluded';
  readonly costKind: 'provider_estimate' | 'unavailable';
}

const Attribute = z.object({ key: z.string().max(128), value: z.unknown() });
const Attributes = z.array(Attribute).max(128);
const LogRecord = z.object({
  // Claude Code stamps `timeUnixNano`; Codex sends "0" there and the real instant in
  // `observedTimeUnixNano` (and an ISO `event.timestamp` attribute). See `sourceNano`.
  timeUnixNano: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  observedTimeUnixNano: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  eventName: z.string().max(128).optional(),
  body: z.unknown().optional(),
  attributes: Attributes.optional(),
});
const ExportLogs = z.object({
  resourceLogs: z
    .array(
      z.object({
        resource: z.object({ attributes: Attributes.optional() }).optional(),
        scopeLogs: z.array(z.object({ logRecords: z.array(LogRecord).max(256) })).max(32),
      }),
    )
    .max(32),
});

const EVENTS = new Set([
  'claude_code.tool_result',
  'claude_code.api_request',
  'claude_code.api_error',
  // Coodra's own hooks and MCP server as the harness observed them (metadata only).
  'claude_code.hook_execution_complete',
  'claude_code.mcp_server_connection',
]);
const IDENTIFIERS = [
  'session.id',
  'app.version',
  'tool_use_id',
  'request_id',
  'client_request_id',
  'prompt.id',
  'agent_id',
  'parent_agent_id',
  'model',
  'tool_name',
  'hook_event',
  'hook_name',
  'hook_source',
  'status',
  'transport_type',
  'server_scope',
  'plugin_id_hash',
] as const;
const NUMBERS = [
  'event.sequence',
  'duration_ms',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost_usd',
  'cost_usd_micros',
  'attempt',
  'status_code',
  'tool_input_size_bytes',
  'tool_result_size_bytes',
  'num_hooks',
  'num_success',
  'num_blocking',
  'num_non_blocking_error',
  'num_cancelled',
  'total_duration_ms',
  'stdout_chars',
  'additional_context_chars',
  'system_message_chars',
  'initial_user_message_chars',
  'num_outputs_persisted',
] as const;
const BOOLEANS = ['success', 'is_plugin', 'managed_only', 'safe_mode'] as const;

export type NativeHarness = 'claude_code' | 'codex';

/**
 * Codex (verified on 0.171.0-alpha.13 via `-c otel.exporter=...otlp-http json`). Event names live in the
 * `event.name` attribute (the record `eventName` is a Rust source location). Codex exports tool
 * `arguments` and `output` in `codex.tool_result` even when `log_user_prompt` is false, plus the
 * account email and id, so everything here is an explicit allowlist and none of those are read.
 * Codex reports no cost.
 */
const CODEX_EVENTS = new Set(['codex.conversation_starts', 'codex.tool_decision', 'codex.tool_result']);
const CODEX_IDENTIFIERS: ReadonlyArray<readonly [raw: string, safe: string]> = [
  ['conversation.id', 'session.id'],
  ['app.version', 'app.version'],
  ['call_id', 'tool_use_id'],
  ['tool_name', 'tool_name'],
  ['model', 'model'],
  ['tool_namespace', 'tool_namespace'],
  ['mcp_server', 'mcp_server'],
  ['agent_name', 'agent_name'],
  ['decision', 'decision'],
  ['source', 'decision_source'],
  ['approval_policy', 'approval_policy'],
  ['sandbox_policy', 'sandbox_policy'],
  ['reasoning_effort', 'reasoning_effort'],
];
const CODEX_NUMBERS: ReadonlyArray<readonly [raw: string, safe: string]> = [
  ['duration_ms', 'duration_ms'],
  ['tool_result_seq', 'tool_result_seq'],
  ['input_token_count', 'input_tokens'],
  ['output_token_count', 'output_tokens'],
  ['cached_token_count', 'cache_read_tokens'],
  ['cache_write_token_count', 'cache_creation_tokens'],
  ['reasoning_token_count', 'reasoning_tokens'],
  ['tool_token_count', 'tool_tokens'],
];
const CODEX_BOOLEANS: ReadonlyArray<readonly [raw: string, safe: string]> = [
  ['success', 'success'],
  ['output_truncated', 'output_truncated'],
];

function boolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value))) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

/** Canonical event name for a Codex record, or null when the event is not collected. */
function codexEventName(raw: Record<string, unknown>): string | null {
  const name = raw['event.name'];
  if (typeof name !== 'string') return null;
  // One completed-response record per model call carries the token usage; the many streaming
  // deltas are deliberately not collected.
  if (name === 'codex.sse_event') return raw['event.kind'] === 'response.completed' ? 'codex.response_completed' : null;
  return CODEX_EVENTS.has(name) ? name : null;
}

function codexSafeAttributes(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [from, to] of CODEX_IDENTIFIERS) {
    const value = identifier(raw[from]);
    if (value !== undefined) safe[to] = value;
  }
  for (const [from, to] of CODEX_NUMBERS) {
    const value = finiteNumber(raw[from]);
    if (value !== undefined) safe[to] = value;
  }
  for (const [from, to] of CODEX_BOOLEANS) {
    const value = boolean(raw[from]);
    if (value !== undefined) safe[to] = value;
  }
  return safe;
}

/**
 * The instant the harness observed the event, as nanoseconds, or null when none is usable.
 * Prefers `timeUnixNano`; Codex leaves it at "0", so fall back to `observedTimeUnixNano`, then to
 * the ISO `event.timestamp` attribute.
 */
function sourceNano(
  record: { timeUnixNano?: string | undefined; observedTimeUnixNano?: string | undefined },
  raw: Record<string, unknown>,
): string | null {
  for (const candidate of [record.timeUnixNano, record.observedTimeUnixNano]) {
    if (candidate !== undefined && candidate !== '' && !/^0+$/.test(candidate)) return candidate;
  }
  const iso = raw['event.timestamp'];
  if (typeof iso === 'string') {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > 0) return String(BigInt(ms) * 1_000_000n);
  }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function scalar(value: unknown): unknown {
  const v = object(value);
  return v.stringValue ?? v.boolValue ?? v.intValue ?? v.doubleValue;
}

function attributes(values: z.infer<typeof Attributes> = []): Record<string, unknown> {
  return Object.fromEntries(values.map(({ key, value }) => [key, scalar(value)]));
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.split('').some((c) => c.charCodeAt(0) < 32)
    ? value
    : undefined;
}

/** Allowlist before queueing: never persist the OTLP body, prompts, errors or tool arguments. */
function safeAttributes(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const key of IDENTIFIERS) {
    const value = identifier(raw[key]);
    if (value !== undefined) safe[key] = value;
  }
  for (const key of NUMBERS) {
    const value = raw[key];
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value))) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER) safe[key] = number;
  }
  for (const key of BOOLEANS) {
    const value = boolean(raw[key]);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export class TelemetryRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type TelemetryLogsReceiver = (
  projectSlug: string,
  body: unknown,
  harness?: NativeHarness,
) => Promise<{
  readonly partialSuccess?: { readonly rejectedLogRecords: string; readonly errorMessage: string };
}>;

const RETENTION_MS = 7 * 86_400_000;
/**
 * Local admission budgets. Sized from measured use: the busiest day in a real local database had
 * 1,028 tool calls, and each call produces about four telemetry rows (tool result, model request
 * and a hook completion each side), so a sustained peak week is roughly 29,000 rows. The retained
 * default leaves headroom over that, and the unattached default covers a 24 hour peak day. Rows are
 * about 0.6 KB, so the default ceiling is on the order of 30 MB. Override with
 * `COODRA_TELEMETRY_MAX_EVENTS` and `COODRA_TELEMETRY_MAX_UNATTACHED`.
 */
export const DEFAULT_MAX_RETAINED_EVENTS = 50_000;
export const DEFAULT_MAX_UNATTACHED_EVENTS = 5_000;

export interface NativeTelemetryLimits {
  readonly maxRetained: number;
  readonly maxUnattached: number;
}

/** Positive integer from an env string; anything else falls back to the default. */
export function parseTelemetryLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Unattached evidence (no Run) is cheaper to forge, so it expires sooner and has its own budget. */
const UNATTACHED_RETENTION_MS = 24 * 3_600_000;

/** Expire only native telemetry rows and its queue payloads (including dead letters). */
export async function pruneNativeTelemetry(db: DbHandle, now = Date.now()): Promise<number> {
  if (db.kind !== 'sqlite') return 0;
  const cutoff = Math.floor((now - RETENTION_MS) / 1000);
  const unattachedCutoff = Math.floor((now - UNATTACHED_RETENTION_MS) / 1000);
  const events = await db.db.run(sql`DELETE FROM native_telemetry_events
    WHERE received_at < ${cutoff} OR (run_id IS NULL AND received_at < ${unattachedCutoff})`);
  // id-prefix (not queue) so pre-revision-2 `run_event` telemetry jobs are also expired.
  const jobs = await db.db.run(sql`DELETE FROM pending_jobs
    WHERE id GLOB 'native_telemetry_*' AND created_at < ${cutoff}`);
  return events.changes + jobs.changes;
}

/** Local-only first slice. It never creates Runs or binds by a transport session/time heuristic. */
export function createNativeTelemetryReceiver(deps: {
  db: DbHandle;
  kick?: () => void;
  limits?: Partial<NativeTelemetryLimits>;
}): TelemetryLogsReceiver {
  const maxRetained = deps.limits?.maxRetained ?? DEFAULT_MAX_RETAINED_EVENTS;
  const maxUnattached = deps.limits?.maxUnattached ?? DEFAULT_MAX_UNATTACHED_EVENTS;
  const receive: TelemetryLogsReceiver = async (projectSlug, body, harness = 'claude_code') => {
    if (deps.db.kind !== 'sqlite') throw new TelemetryRequestError(503, 'local_storage_required');
    const parsed = ExportLogs.safeParse(body);
    if (!parsed.success) throw new TelemetryRequestError(400, 'invalid_otlp_logs');
    const records = parsed.data.resourceLogs.flatMap((resource) =>
      resource.scopeLogs.flatMap((scope) =>
        scope.logRecords.map((record) => ({ record, resource: attributes(resource.resource?.attributes) })),
      ),
    );
    if (records.length > 256) throw new TelemetryRequestError(413, 'too_many_log_records');
    const project = await lookupProjectBySlug(deps.db, projectSlug);
    if (!project) throw new TelemetryRequestError(404, 'project_not_found');
    let rejected = 0;
    const pending: { id: string; payload: NativeTelemetryPayloadV1 }[] = [];
    for (const { record, resource } of records) {
      const raw = { ...resource, ...attributes(record.attributes) };
      let name: string | null;
      let safe: Record<string, string | number | boolean>;
      if (harness === 'codex') {
        name = codexEventName(raw);
        safe = codexSafeAttributes(raw);
      } else {
        const candidate = record.eventName ?? scalar(record.body) ?? raw['event.name'];
        const claudeName =
          typeof candidate === 'string' && candidate.startsWith('claude_code.')
            ? candidate
            : `claude_code.${String(candidate)}`;
        name = EVENTS.has(claudeName) ? claudeName : null;
        safe = safeAttributes(raw);
      }
      const sessionId = identifier(safe['session.id']);
      const nano = sourceNano(record, raw);
      const sourceMillis = nano === null ? Number.NaN : Number(BigInt(nano) / 1_000_000n);
      if (
        name === null ||
        nano === null ||
        sessionId === undefined ||
        sourceMillis < Date.now() - RETENTION_MS ||
        sourceMillis > Date.now() + 300_000
      ) {
        rejected += 1;
        continue;
      }
      // Resolve exact project + harness + native session; do not normalize away native identity.
      const t = sqliteSchema.runs;
      const rows = await deps.db.db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.projectId, project.id), eq(t.sessionId, sessionId), eq(t.agentType, harness)))
        .limit(1);
      // No Run yet is accepted, not retried: the hooks may never create one, and that is exactly
      // the evidence an independent channel exists to keep. The row stays unattached (run_id NULL)
      // until a Run for the same project + session + harness appears.
      const run = rows[0] ?? null;
      const observation: NativeTelemetryObservation = {
        version: 1,
        harness,
        source: 'otlp_logs',
        eventName: name,
        sourceTimeUnixNano: nano,
        receivedAt: new Date().toISOString(),
        projectId: project.id,
        runId: run?.id ?? null,
        sessionId,
        attributes: safe,
        content: 'excluded',
        costKind:
          name === 'claude_code.api_request' && (safe.cost_usd !== undefined || safe.cost_usd_micros !== undefined)
            ? 'provider_estimate'
            : 'unavailable',
      };
      // Excludes receipt time and raw content. Source timestamp prevents sequence-reset collisions on resume.
      // runId is excluded so the same event keeps one identity whether or not a Run existed at receipt.
      const { receivedAt: _receivedAt, runId: _runId, ...identity } = observation;
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const id = `native_telemetry_${digest}`;
      const num = (key: string): number | null => {
        const v = safe[key];
        return typeof v === 'number' ? Math.trunc(v) : null;
      };
      const str = (key: string): string | null => {
        const v = safe[key];
        return typeof v === 'string' ? v : null;
      };
      const micros =
        safe.cost_usd_micros !== undefined
          ? num('cost_usd_micros')
          : typeof safe.cost_usd === 'number'
            ? Math.round(safe.cost_usd * 1_000_000)
            : null;
      pending.push({
        id,
        payload: {
          v: 1,
          rowId: id,
          projectId: project.id,
          runId: run?.id ?? null,
          harness: observation.harness,
          source: observation.source,
          eventName: name,
          sourceTimeUnixNano: nano,
          sourceTimeMs: sourceMillis,
          sessionId,
          costKind: observation.costKind,
          attributesJson: JSON.stringify(safe),
          receivedAt: observation.receivedAt,
          appVersion: str('app.version'),
          toolUseId: str('tool_use_id'),
          toolName: str('tool_name'),
          requestId: str('request_id'),
          clientRequestId: str('client_request_id'),
          promptId: str('prompt.id'),
          agentId: str('agent_id'),
          parentAgentId: str('parent_agent_id'),
          model: str('model'),
          success: typeof safe.success === 'boolean' ? safe.success : null,
          eventSequence: num('event.sequence'),
          durationMs: num('duration_ms') ?? num('total_duration_ms'),
          statusCode: num('status_code'),
          attempt: num('attempt'),
          inputTokens: num('input_tokens'),
          outputTokens: num('output_tokens'),
          cacheReadTokens: num('cache_read_tokens'),
          cacheCreationTokens: num('cache_creation_tokens'),
          toolInputSizeBytes: num('tool_input_size_bytes'),
          toolResultSizeBytes: num('tool_result_size_bytes'),
          hookEvent: str('hook_event'),
          hookName: str('hook_name'),
          hookCount: num('num_hooks'),
          hookSuccessCount: num('num_success'),
          hookBlockingCount: num('num_blocking'),
          hookErrorCount: num('num_non_blocking_error'),
          hookCancelledCount: num('num_cancelled'),
          connectionStatus: str('status'),
          transportType: str('transport_type'),
          serverScope: str('server_scope'),
          pluginIdHash: str('plugin_id_hash'),
          costUsdMicros: micros,
        },
      });
    }
    const retained = await deps.db.db.all<{ id: string }>(sql`SELECT id FROM native_telemetry_events
      UNION SELECT id FROM pending_jobs WHERE id GLOB 'native_telemetry_*'`);
    const retainedIds = new Set(retained.map(({ id }) => id));
    for (const { id } of pending) retainedIds.add(id);
    if (retainedIds.size > maxRetained) {
      throw new TelemetryRequestError(503, 'telemetry_capacity_exceeded');
    }
    const unattachedIds = new Set(
      (
        await deps.db.db.all<{ id: string }>(sql`SELECT id FROM native_telemetry_events WHERE run_id IS NULL
          UNION SELECT id FROM pending_jobs
            WHERE id GLOB 'native_telemetry_*' AND json_extract(payload, '$.runId') IS NULL`)
      ).map(({ id }) => id),
    );
    for (const { id, payload } of pending) if (payload.runId === null) unattachedIds.add(id);
    if (unattachedIds.size > maxUnattached) {
      throw new TelemetryRequestError(503, 'telemetry_unattached_capacity_exceeded');
    }
    // No sync_to_cloud job: native telemetry is project-local until sharing is explicitly scoped.
    for (const { id, payload } of pending) {
      await scheduleDurableWrite(deps.db, {
        id,
        queue: 'native_telemetry',
        payload,
        projectId: payload.projectId,
        ...(payload.runId !== null ? { runId: payload.runId } : {}),
      });
    }
    if (pending.length > 0) deps.kick?.();
    return rejected > 0
      ? {
          partialSuccess: {
            rejectedLogRecords: String(rejected),
            errorMessage: 'unsupported_event_or_missing_source_identity',
          },
        }
      : {};
  };
  // Serialize admission so concurrent HTTP exports cannot overrun the local retention budget.
  let previous: Promise<unknown> = Promise.resolve();
  return (projectSlug, body, harness) => {
    const result = previous.then(() => receive(projectSlug, body, harness));
    previous = result.catch(() => undefined);
    return result;
  };
}
