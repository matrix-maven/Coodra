import type {
  OutboxDispatchHandler,
  OutboxDispatchOutcome,
  OutboxJob,
  SyncLookup,
} from '@coodra/contextos-cli/lib/outbox';
import {
  type DbHandle,
  type PostgresHandle,
  postgresSchema,
  type SqliteHandle,
  sqliteSchema,
} from '@coodra/contextos-db';
import { createLogger, type Logger } from '@coodra/contextos-shared';
import { and, eq } from 'drizzle-orm';

/**
 * `apps/sync-daemon/src/lib/dispatch` — Module 04a S3.
 *
 * The dispatch handler the sync-daemon's OutboxWorker invokes for each
 * `sync_to_cloud` row. The daemon holds two DB handles: a local SQLite
 * (the source of truth for audit rows) and a cloud Postgres (the team
 * destination). For each job:
 *
 *   1. Validate payload shape (v=1, table, lookup).
 *   2. SELECT the canonical row from local SQLite by the lookup key.
 *   3. INSERT the row into cloud Postgres with the appropriate
 *      ON CONFLICT clause (DO NOTHING for append-only tables;
 *      DO UPDATE for `runs` so a session_close push refreshes
 *      status + ended_at).
 *   4. Return `success` on landing, `transient_failure` on any thrown
 *      error (cloud unreachable, FK not yet present, BUSY) so the
 *      worker retries on backoff. Return `permanent_failure` on a
 *      payload-shape mismatch (programming bug).
 *
 * Why the SELECT-then-INSERT pattern (not "carry the full row in the
 * payload"): the audit rows are append-only, so the local SELECT always
 * returns the canonical state. For `runs` rows that get updated at
 * SessionEnd, the SELECT picks up the latest state at dispatch time —
 * exactly what the cloud should see.
 *
 * FK satisfaction. `run_events.run_id` and `policy_decisions.run_id`
 * may reference a `runs` row that hasn't been synced yet. If the cloud
 * INSERT raises an FK violation, we return `transient_failure` so the
 * worker retries on backoff (1s/5s/30s/...). By 30s the parent runs
 * row should have synced and the retry succeeds. The maxAttempts
 * give-up is the safety net for FKs that genuinely will never satisfy.
 */

export interface CreateSyncDispatchHandlerDeps {
  readonly localDb: SqliteHandle;
  readonly cloudDb: PostgresHandle;
  readonly logger?: Logger;
}

const PERMANENT = (error: string): OutboxDispatchOutcome => ({ status: 'permanent_failure', error });
const TRANSIENT = (error: string): OutboxDispatchOutcome => ({ status: 'transient_failure', error });
const SUCCESS: OutboxDispatchOutcome = { status: 'success' };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readLookup(value: unknown): SyncLookup | null {
  if (!isObject(value)) return null;
  if (value.kind === 'id' && typeof value.value === 'string') {
    return { kind: 'id', value: value.value };
  }
  if (value.kind === 'idempotency_key' && typeof value.value === 'string') {
    return { kind: 'idempotency_key', value: value.value };
  }
  if (value.kind === 'project_session' && typeof value.projectId === 'string' && typeof value.sessionId === 'string') {
    return { kind: 'project_session', projectId: value.projectId, sessionId: value.sessionId };
  }
  return null;
}

const SYNC_TABLES = [
  'runs',
  'run_events',
  'policy_decisions',
  'decisions',
  'context_packs',
  // M04 S8a — extends M04a OQ-1 from one-way push to bidirectional sync.
  'kill_switches',
] as const;
type SyncTableName = (typeof SYNC_TABLES)[number];

function isSyncTable(value: unknown): value is SyncTableName {
  return typeof value === 'string' && (SYNC_TABLES as ReadonlyArray<string>).includes(value);
}

export function createSyncDispatchHandler(deps: CreateSyncDispatchHandlerDeps): OutboxDispatchHandler {
  if (deps.localDb?.kind !== 'sqlite') {
    throw new TypeError('createSyncDispatchHandler: localDb must be a SqliteHandle');
  }
  if (deps.cloudDb?.kind !== 'postgres') {
    throw new TypeError('createSyncDispatchHandler: cloudDb must be a PostgresHandle');
  }
  const log = deps.logger ?? createLogger('sync-daemon.dispatch');
  const localDb = deps.localDb;
  const cloudDb = deps.cloudDb;

  return async function dispatchSyncJob(job: OutboxJob): Promise<OutboxDispatchOutcome> {
    if (job.queue !== 'sync_to_cloud') {
      return PERMANENT(`sync-daemon dispatcher received non-sync queue '${job.queue}'`);
    }
    const payload = job.payload;
    if (!isObject(payload)) {
      return PERMANENT('sync_to_cloud payload is not an object');
    }
    if (payload.v !== 1) {
      return PERMANENT(`unsupported sync_to_cloud payload version ${String(payload.v)}`);
    }
    if (!isSyncTable(payload.table)) {
      return PERMANENT(`unknown sync_to_cloud table '${String(payload.table)}'`);
    }
    const lookup = readLookup(payload.lookup);
    if (lookup === null) {
      return PERMANENT('sync_to_cloud payload missing or malformed lookup');
    }

    try {
      const found = await syncOne({ localDb, cloudDb, table: payload.table, lookup, log, jobId: job.id });
      if (!found) {
        // Local row not yet present — paired audit job hasn't dispatched
        // yet. Retry on backoff; by 1–5s the audit row should land.
        return TRANSIENT(`local ${payload.table} row not found for lookup ${lookup.kind}=${describeLookup(lookup)}`);
      }
      return SUCCESS;
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause);
      log.warn(
        { event: 'sync_dispatch_threw', jobId: job.id, table: payload.table, err: msg },
        'sync dispatch threw — treating as transient',
      );
      return TRANSIENT(msg);
    }
  };
}

function describeLookup(lookup: SyncLookup): string {
  if (lookup.kind === 'project_session') return `${lookup.projectId}/${lookup.sessionId}`;
  return lookup.value;
}

interface SyncOneArgs {
  readonly localDb: SqliteHandle;
  readonly cloudDb: PostgresHandle;
  readonly table: SyncTableName;
  readonly lookup: SyncLookup;
  readonly log: Logger;
  readonly jobId: string;
}

/**
 * Per-table SELECT-from-local + INSERT-to-cloud. Returns true when the
 * row was found locally and pushed (or already present on cloud);
 * false when no local row matches the lookup (caller treats as
 * transient_failure — paired audit hasn't dispatched yet).
 */
async function syncOne(args: SyncOneArgs): Promise<boolean> {
  switch (args.table) {
    case 'runs':
      return syncRuns(args);
    case 'run_events':
      return syncRunEvents(args);
    case 'policy_decisions':
      return syncPolicyDecisions(args);
    case 'decisions':
      return syncDecisions(args);
    case 'context_packs':
      return syncContextPacks(args);
    case 'kill_switches':
      return syncKillSwitches(args);
  }
}

/**
 * M04 S8a — push side of bidirectional kill_switches sync. Pause/resume
 * on developer A enqueues a sync_to_cloud row; this dispatcher pushes
 * the local row to cloud Postgres. Resume operations land here too —
 * the row's `resumed_at` field gets updated via ON CONFLICT DO UPDATE.
 *
 * The puller in apps/sync-daemon/src/lib/kill-switch-puller.ts handles
 * the cloud → local direction.
 */
async function syncKillSwitches({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.killSwitches;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  const ct = postgresSchema.killSwitches;
  await cloudDb.db
    .insert(ct)
    .values({
      id: row.id,
      scope: row.scope,
      target: row.target,
      mode: row.mode,
      reason: row.reason,
      pausedBySessionId: row.pausedBySessionId,
      pausedAt: row.pausedAt,
      expiresAt: row.expiresAt,
      resumedAt: row.resumedAt,
      resumedBySessionId: row.resumedBySessionId,
    })
    .onConflictDoUpdate({
      target: [ct.id],
      set: {
        // Resume + expiry updates are the only mutating dimensions
        // post-insert. Reason / scope / target / mode are immutable
        // (a re-pause inserts a fresh row).
        resumedAt: row.resumedAt,
        resumedBySessionId: row.resumedBySessionId,
        expiresAt: row.expiresAt,
      },
    });
  log.debug(
    { event: 'sync_kill_switches_pushed', jobId, killSwitchId: row.id, scope: row.scope, target: row.target },
    'kill_switches row pushed to cloud',
  );
  return true;
}

async function syncRuns({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  const lt = sqliteSchema.runs;
  let row: typeof lt.$inferSelect | undefined;
  if (lookup.kind === 'id') {
    row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  } else if (lookup.kind === 'project_session') {
    row = (
      await localDb.db
        .select()
        .from(lt)
        .where(and(eq(lt.projectId, lookup.projectId), eq(lt.sessionId, lookup.sessionId)))
        .limit(1)
    )[0];
  } else {
    return false;
  }
  if (!row) return false;
  const ct = postgresSchema.runs;
  await cloudDb.db
    .insert(ct)
    .values({
      id: row.id,
      projectId: row.projectId,
      sessionId: row.sessionId,
      agentType: row.agentType,
      mode: row.mode,
      status: row.status,
      issueRef: row.issueRef,
      prRef: row.prRef,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
    })
    .onConflictDoUpdate({
      target: [ct.projectId, ct.sessionId],
      set: {
        status: row.status,
        endedAt: row.endedAt,
        issueRef: row.issueRef,
        prRef: row.prRef,
      },
    });
  log.debug({ event: 'sync_runs_pushed', jobId, runId: row.id, sessionId: row.sessionId }, 'runs row synced');
  return true;
}

async function syncRunEvents({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.runEvents;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  await cloudDb.db
    .insert(postgresSchema.runEvents)
    .values({
      id: row.id,
      runId: row.runId,
      phase: row.phase,
      toolName: row.toolName,
      toolUseId: row.toolUseId,
      toolInput: row.toolInput,
      outcome: row.outcome,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing({ target: postgresSchema.runEvents.id });
  log.debug({ event: 'sync_run_events_pushed', jobId, eventId: row.id }, 'run_events row synced');
  return true;
}

async function syncPolicyDecisions({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'idempotency_key') return false;
  const lt = sqliteSchema.policyDecisions;
  const row = (await localDb.db.select().from(lt).where(eq(lt.idempotencyKey, lookup.value)).limit(1))[0];
  if (!row) return false;
  await cloudDb.db
    .insert(postgresSchema.policyDecisions)
    .values({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      runId: row.runId,
      sessionId: row.sessionId,
      projectId: row.projectId,
      agentType: row.agentType,
      eventType: row.eventType,
      toolName: row.toolName,
      toolInputSnapshot: row.toolInputSnapshot,
      permissionDecision: row.permissionDecision,
      matchedRuleId: row.matchedRuleId,
      reason: row.reason,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing({ target: postgresSchema.policyDecisions.idempotencyKey });
  log.debug({ event: 'sync_policy_decisions_pushed', jobId, key: row.idempotencyKey }, 'policy_decisions row synced');
  return true;
}

async function syncDecisions({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'idempotency_key') return false;
  const lt = sqliteSchema.decisions;
  const row = (await localDb.db.select().from(lt).where(eq(lt.idempotencyKey, lookup.value)).limit(1))[0];
  if (!row) return false;
  await cloudDb.db
    .insert(postgresSchema.decisions)
    .values({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      runId: row.runId,
      description: row.description,
      rationale: row.rationale,
      alternatives: row.alternatives,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing({ target: postgresSchema.decisions.idempotencyKey });
  log.debug({ event: 'sync_decisions_pushed', jobId, key: row.idempotencyKey }, 'decisions row synced');
  return true;
}

async function syncContextPacks({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.contextPacks;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  // summary_embedding: SQLite stores as text (or null); Postgres has a
  // vector(384) column. M02 deferred cross-dialect embedding sync.
  // For S3 we push everything except the embedding; the cloud HNSW
  // index materialises lazily when the daemon (or future ingest path)
  // populates it. NOT NULL columns we still send.
  await cloudDb.db
    .insert(postgresSchema.contextPacks)
    .values({
      id: row.id,
      runId: row.runId,
      projectId: row.projectId,
      title: row.title,
      content: row.content,
      contentExcerpt: row.contentExcerpt,
      createdAt: row.createdAt,
    })
    .onConflictDoNothing({ target: postgresSchema.contextPacks.id });
  log.debug({ event: 'sync_context_packs_pushed', jobId, packId: row.id }, 'context_packs row synced');
  return true;
}

/**
 * Hint: callers pass a `SqliteHandle` and `PostgresHandle` directly.
 * If you have a generic `DbHandle` and want a runtime check, use this
 * narrowing helper.
 */
export function assertSqliteHandle(handle: DbHandle): asserts handle is SqliteHandle {
  if (handle.kind !== 'sqlite') throw new TypeError(`expected SqliteHandle, got kind='${handle.kind}'`);
}

export function assertPostgresHandle(handle: DbHandle): asserts handle is PostgresHandle {
  if (handle.kind !== 'postgres') throw new TypeError(`expected PostgresHandle, got kind='${handle.kind}'`);
}
