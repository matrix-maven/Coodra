import { createHash } from 'node:crypto';
import type { RunEventPayloadV1 } from '@coodra/cli/lib/outbox';
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
  readonly runId: string;
  readonly sessionId: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly content: 'excluded';
  readonly costKind: 'provider_estimate' | 'unavailable';
}

const Attribute = z.object({ key: z.string().max(128), value: z.unknown() });
const Attributes = z.array(Attribute).max(128);
const LogRecord = z.object({
  timeUnixNano: z.string().regex(/^\d{1,20}$/),
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

const EVENTS = new Set(['claude_code.tool_result', 'claude_code.api_request', 'claude_code.api_error']);
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
] as const;

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
  if (raw.success === true || raw.success === 'true') safe.success = true;
  if (raw.success === false || raw.success === 'false') safe.success = false;
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
) => Promise<{
  readonly partialSuccess?: { readonly rejectedLogRecords: string; readonly errorMessage: string };
}>;

const RETENTION_MS = 7 * 86_400_000;
const MAX_RETAINED_EVENTS = 10_000;

/** Expire only this receiver's local evidence and queue payloads, including dead letters. */
export async function pruneNativeTelemetry(db: DbHandle, now = Date.now()): Promise<number> {
  if (db.kind !== 'sqlite') return 0;
  const cutoff = Math.floor((now - RETENTION_MS) / 1000);
  const events = await db.db.run(sql`DELETE FROM run_events
    WHERE phase = 'telemetry' AND id GLOB 'native_telemetry_*' AND created_at < ${cutoff}`);
  const jobs = await db.db.run(sql`DELETE FROM pending_jobs
    WHERE id GLOB 'native_telemetry_*' AND created_at < ${cutoff}`);
  return events.changes + jobs.changes;
}

/** Local-only first slice. It never creates Runs or binds by a transport session/time heuristic. */
export function createNativeTelemetryReceiver(deps: { db: DbHandle; kick?: () => void }): TelemetryLogsReceiver {
  const receive: TelemetryLogsReceiver = async (projectSlug, body) => {
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
    const pending: { id: string; payload: RunEventPayloadV1 }[] = [];
    for (const { record, resource } of records) {
      const raw = { ...resource, ...attributes(record.attributes) };
      const candidate = record.eventName ?? scalar(record.body) ?? raw['event.name'];
      const name =
        typeof candidate === 'string' && candidate.startsWith('claude_code.')
          ? candidate
          : `claude_code.${String(candidate)}`;
      const safe = safeAttributes(raw);
      const sessionId = identifier(safe['session.id']);
      const sourceMillis = Number(BigInt(record.timeUnixNano) / 1_000_000n);
      if (
        !EVENTS.has(name) ||
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
        .where(and(eq(t.projectId, project.id), eq(t.sessionId, sessionId), eq(t.agentType, 'claude_code')))
        .limit(1);
      const run = rows[0];
      // A whole-batch retry is safe, including when earlier exports already landed.
      if (!run) throw new TelemetryRequestError(503, 'run_not_available_retry');
      const observation: NativeTelemetryObservation = {
        version: 1,
        harness: 'claude_code',
        source: 'otlp_logs',
        eventName: name,
        sourceTimeUnixNano: record.timeUnixNano,
        receivedAt: new Date().toISOString(),
        projectId: project.id,
        runId: run.id,
        sessionId,
        attributes: safe,
        content: 'excluded',
        costKind:
          name === 'claude_code.api_request' && (safe.cost_usd !== undefined || safe.cost_usd_micros !== undefined)
            ? 'provider_estimate'
            : 'unavailable',
      };
      // Excludes receipt time and raw content. Source timestamp prevents sequence-reset collisions on resume.
      const { receivedAt: _receivedAt, ...identity } = observation;
      const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const id = `native_telemetry_${digest}`;
      pending.push({
        id,
        payload: {
          v: 1,
          rowId: id,
          resolution: { kind: 'pre_resolved', runId: run.id },
          phase: 'telemetry',
          toolName: name,
          toolUseId: identifier(safe.tool_use_id) ?? id,
          toolInput: JSON.stringify({ input: {}, output: observation }),
          outcome: null,
        },
      });
    }
    const retained = await deps.db.db.all<{ id: string }>(sql`SELECT DISTINCT id FROM (
      SELECT id FROM run_events WHERE phase = 'telemetry' AND id GLOB 'native_telemetry_*'
      UNION SELECT id FROM pending_jobs WHERE id GLOB 'native_telemetry_*'
    )`);
    const retainedIds = new Set(retained.map(({ id }) => id));
    for (const { id } of pending) retainedIds.add(id);
    if (retainedIds.size > MAX_RETAINED_EVENTS) {
      throw new TelemetryRequestError(503, 'telemetry_capacity_exceeded');
    }
    // No sync_to_cloud job: native telemetry is project-local until sharing is explicitly scoped.
    for (const { id, payload } of pending) {
      await scheduleDurableWrite(deps.db, { id, queue: 'run_event', payload });
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
  return (projectSlug, body) => {
    const result = previous.then(() => receive(projectSlug, body));
    previous = result.catch(() => undefined);
    return result;
  };
}
