import type {
  OutboxDispatchHandler,
  OutboxDispatchOutcome,
  OutboxJob,
  SyncLookup,
} from '@coodra/cli/lib/outbox';
import {
  type DbHandle,
  type PostgresHandle,
  postgresSchema,
  type SqliteHandle,
  sqliteSchema,
} from '@coodra/db';
import { createLogger, type Logger } from '@coodra/shared';
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
  // M04 Phase 4 / Phase G+H verification — projects must land in cloud
  // before any runs/decisions/etc that FK to it can land.
  'projects',
  'runs',
  'run_events',
  'policy_decisions',
  'decisions',
  'context_packs',
  // M04 S8a — extends M04a OQ-1 from one-way push to bidirectional sync.
  'kill_switches',
  // Phase F.1 (2026-05-11) — on-demand skill recipes. Sync the local
  // SQLite `features` row to cloud Postgres so teammates pull it via
  // team-rows-puller and the puller writes the markdown back to disk.
  // Closes the "knowledge artifacts are git-distributed not Coodra-
  // distributed" gap from Phase E's demo audit.
  'features',
  // Phase F.2 (2026-05-11) — module blueprint cloud sync. Same idea
  // as features, applied to the heavier feature_packs layer (spec.md
  // + implementation.md + techstack.md + meta.json bundled into the
  // `content_json` column added by migration 0015/0016).
  'feature_packs',
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
      // postgres-js attaches `.code`, `.detail`, `.constraint`, `.table`
      // to the error. Without explicitly logging them, the only visible
      // text is "Failed query: <sql>\nparams: <values>" which never
      // tells the operator WHY the insert was rejected. Surface the
      // structured fields so FK violations / NOT NULL / unique-conflict
      // diagnoses are obvious in the daemon log.
      const pgCode = cause !== null && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
      const pgDetail =
        cause !== null && typeof cause === 'object' && 'detail' in cause ? String(cause.detail) : undefined;
      const pgConstraint =
        cause !== null && typeof cause === 'object' && 'constraint_name' in cause
          ? String((cause as { constraint_name: unknown }).constraint_name)
          : undefined;
      log.warn(
        {
          event: 'sync_dispatch_threw',
          jobId: job.id,
          table: payload.table,
          err: msg,
          pgCode,
          pgDetail,
          pgConstraint,
        },
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
    case 'projects':
      return syncProjects(args);
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
    case 'features':
      return syncFeatures(args);
    case 'feature_packs':
      return syncFeaturePacks(args);
  }
}

/**
 * Sentinel org_ids — rows belonging to these orgs are LOCAL-ONLY and
 * must never be pushed to cloud. Trying to push them would FK-violate
 * because the parent project row is never synced. Pre-fix (2026-05-11)
 * these would dead-letter; post-fix they get a clean "skip" outcome
 * that consumes the job successfully.
 */
const LOCAL_ONLY_ORGS: ReadonlySet<string> = new Set(['__solo__', '__global__']);

/**
 * Phase H.1 (2026-05-12) — ensure the parent `projects` row is in cloud
 * before a dependent feature/feature_packs row tries to FK to it. Mirrors
 * `ensureRunAndProjectInCloud` but scoped to the project (no runs row).
 *
 * Used by `syncFeatures` because the order in which projects-vs-features
 * sync jobs are claimed by the daemon worker isn't deterministic. When a
 * user runs `coodra feature add greet` from a freshly init'd project,
 * the projects job + features job land in `pending_jobs` in that order
 * but the OutboxWorker may claim them concurrently. Without this guard,
 * the features INSERT can race ahead of the projects INSERT and fail FK.
 *
 * Returns:
 *   - 'pushed'     — project row is now in cloud (newly inserted or already).
 *   - 'local_only' — project's org is a local-only sentinel; caller MUST
 *                    NOT push its dependent row.
 *   - 'missing'    — local projects row not found; caller treats as
 *                    transient (paired audit hasn't dispatched yet).
 */
async function ensureProjectInCloud(
  localDb: SqliteHandle,
  cloudDb: PostgresHandle,
  projectId: string,
): Promise<EnsureParentOutcome> {
  const helperLog = createLogger('sync-daemon.ensure-project');
  const localProject = (
    await localDb.db.select().from(sqliteSchema.projects).where(eq(sqliteSchema.projects.id, projectId)).limit(1)
  )[0];
  if (localProject === undefined) {
    helperLog.warn(
      { event: 'ensure_project_local_missing', projectId },
      'local projects row missing; cannot push parent',
    );
    return 'missing';
  }
  if (localProject.id === '__global__' || LOCAL_ONLY_ORGS.has(localProject.orgId)) {
    helperLog.info(
      { event: 'ensure_project_local_only', projectId, orgId: localProject.orgId },
      'project is local-only; skipping cloud chain',
    );
    return 'local_only';
  }
  helperLog.info(
    { event: 'ensure_project_pushing', projectId, slug: localProject.slug },
    'pushing parent project to cloud (features/feature_packs guard)',
  );
  await cloudDb.db
    .insert(postgresSchema.projects)
    .values({
      id: localProject.id,
      slug: localProject.slug,
      orgId: localProject.orgId,
      name: localProject.name,
      cwd: localProject.cwd,
    })
    .onConflictDoNothing({ target: [postgresSchema.projects.id] });
  return 'pushed';
}

/**
 * Resolve the org_id of a project by id from the local SQLite. Returns
 * null when the project row doesn't exist (which would be a real bug
 * worth dead-lettering — the caller still attempts the cloud insert
 * and gets a clear FK error in that case).
 */
async function getLocalProjectOrgId(localDb: SqliteHandle, projectId: string): Promise<string | null> {
  const lp = sqliteSchema.projects;
  const rows = await localDb.db.select({ orgId: lp.orgId }).from(lp).where(eq(lp.id, projectId)).limit(1);
  return rows[0]?.orgId ?? null;
}

/**
 * Phase clarity-pass fix (2026-05-11): suppress sync for writes whose
 * parent project belongs to a local-only sentinel org. The CLI / bridge
 * / MCP server schedule sync jobs based on `process.env.COODRA_MODE`
 * alone, which is correct at the MACHINE level but doesn't see the
 * per-PROJECT org_id. A solo-era project still tagged `__solo__` would
 * have its writes enqueued for cloud sync after a machine flip to team
 * mode, then permanently fail the cloud insert because cloud has no
 * matching project row.
 *
 * Resolution: a permissive consumer-side guard. When we discover the
 * row's project is local-only, log + return true (consume the job
 * without a cloud round-trip). This keeps the dead-letter clean and
 * makes the round-trip latency the same as a successful push.
 */
function shouldSkipLocalOnly(orgId: string | null, log: Logger, jobId: string, table: string): boolean {
  if (orgId === null) return false;
  if (!LOCAL_ONLY_ORGS.has(orgId)) return false;
  log.info({ event: 'sync_skipped_local_only', jobId, table, orgId }, 'skipping cloud sync for local-only org');
  return true;
}

/**
 * M04 Phase 4 — projects push. Without this, cloud `runs` inserts hit
 * an FK violation against `projects(id)` and the entire team-mode
 * sync chain blocks. Projects are mostly-immutable bootstrap state;
 * `cwd` is the one mutable field (backfilled when an existing row is
 * re-encountered with a known cwd). ON CONFLICT (id) DO UPDATE on cwd
 * keeps the cloud row fresh.
 */
async function syncProjects({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.projects;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  if (shouldSkipLocalOnly(row.orgId, log, jobId, 'projects')) return true;
  const ct = postgresSchema.projects;
  await cloudDb.db
    .insert(ct)
    .values({
      id: row.id,
      slug: row.slug,
      orgId: row.orgId,
      name: row.name,
      cwd: row.cwd,
    })
    .onConflictDoUpdate({
      target: [ct.id],
      set: {
        cwd: row.cwd,
        name: row.name,
        updatedAt: new Date(),
      },
    });
  log.debug({ event: 'sync_projects_pushed', jobId, projectId: row.id, slug: row.slug }, 'projects row synced');
  return true;
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
      // M04 Phase 4 actor identity columns.
      pausedByUserId: row.pausedByUserId,
      resumedByUserId: row.resumedByUserId,
    })
    .onConflictDoUpdate({
      target: [ct.id],
      set: {
        // Resume + expiry updates are the only mutating dimensions
        // post-insert. Reason / scope / target / mode are immutable
        // (a re-pause inserts a fresh row).
        resumedAt: row.resumedAt,
        resumedBySessionId: row.resumedBySessionId,
        resumedByUserId: row.resumedByUserId,
        expiresAt: row.expiresAt,
      },
    });
  log.debug(
    { event: 'sync_kill_switches_pushed', jobId, killSwitchId: row.id, scope: row.scope, target: row.target },
    'kill_switches row pushed to cloud',
  );
  return true;
}

/**
 * Push the local runs row identified by `runId` (and its parent project)
 * to cloud as a no-op-on-conflict insert. Called inline by every
 * dependent dispatcher (run_events, policy_decisions, decisions,
 * context_packs) before its own INSERT, so cloud always has the FK
 * parent before the child INSERT runs. Without this, dispatch order
 * across separate jobs is non-deterministic and dependents fail with
 * FK violations until the daemon happens to claim the parent runs job
 * first — which the queue's `created_at` ordering doesn't guarantee.
 */
/**
 * Result of `ensureRunAndProjectInCloud`:
 *   - 'pushed' — the parent project + run rows are now present in cloud
 *     (either newly inserted or already there). Caller can safely insert
 *     its dependent row.
 *   - 'local_only' — the parent project belongs to a local-only org
 *     (`__solo__` / `__global__`). Caller MUST NOT insert its dependent
 *     row to cloud (FK would fail). Treat the sync job as a successful
 *     skip.
 *   - 'missing' — local runs row not found. Caller treats as transient
 *     failure (paired audit may not have committed yet).
 */
type EnsureParentOutcome = 'pushed' | 'local_only' | 'missing';

async function ensureRunAndProjectInCloud(
  localDb: SqliteHandle,
  cloudDb: PostgresHandle,
  runId: string,
): Promise<EnsureParentOutcome> {
  const helperLog = createLogger('sync-daemon.ensure-parent');
  const localRun = (
    await localDb.db.select().from(sqliteSchema.runs).where(eq(sqliteSchema.runs.id, runId)).limit(1)
  )[0];
  if (!localRun) {
    helperLog.warn({ event: 'ensure_parent_local_run_missing', runId }, 'local runs row missing; cannot push parent chain');
    return 'missing';
  }
  // Parent project first. If it's local-only (solo / global sentinel),
  // signal back to the caller that the whole chain stays on the laptop.
  // Pre-fix (2026-05-11) we'd skip the project insert but still try the
  // runs insert, which FK-failed and dead-lettered the job. Post-fix we
  // return 'local_only' so the caller's dependent insert is skipped too.
  const localProject = (
    await localDb.db.select().from(sqliteSchema.projects).where(eq(sqliteSchema.projects.id, localRun.projectId)).limit(1)
  )[0];
  if (localProject === undefined || localProject.id === '__global__' || LOCAL_ONLY_ORGS.has(localProject.orgId)) {
    helperLog.info(
      { event: 'ensure_parent_local_only', runId, projectId: localRun.projectId, orgId: localProject?.orgId ?? '(no project row)' },
      'parent project is local-only; skipping cloud chain',
    );
    return 'local_only';
  }
  helperLog.info(
    { event: 'ensure_parent_pushing', runId, projectId: localRun.projectId, sessionId: localRun.sessionId },
    'pushing parent project + run to cloud',
  );
  await cloudDb.db
    .insert(postgresSchema.projects)
    .values({
      id: localProject.id,
      slug: localProject.slug,
      orgId: localProject.orgId,
      name: localProject.name,
      cwd: localProject.cwd,
    })
    .onConflictDoNothing({ target: [postgresSchema.projects.id] });
  // Then the runs row.
  await cloudDb.db
    .insert(postgresSchema.runs)
    .values({
      id: localRun.id,
      projectId: localRun.projectId,
      sessionId: localRun.sessionId,
      agentType: localRun.agentType,
      mode: localRun.mode,
      status: localRun.status,
      issueRef: localRun.issueRef,
      prRef: localRun.prRef,
      startedAt: localRun.startedAt,
      endedAt: localRun.endedAt,
      baseSha: localRun.baseSha,
      createdByUserId: localRun.createdByUserId,
    })
    .onConflictDoNothing({ target: [postgresSchema.runs.projectId, postgresSchema.runs.sessionId] });
  return 'pushed';
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
  if (shouldSkipLocalOnly(await getLocalProjectOrgId(localDb, row.projectId), log, jobId, 'runs')) return true;
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
      // M04 Phase 4 / Module 06.
      baseSha: row.baseSha,
      createdByUserId: row.createdByUserId,
    })
    .onConflictDoUpdate({
      target: [ct.projectId, ct.sessionId],
      set: {
        status: row.status,
        endedAt: row.endedAt,
        issueRef: row.issueRef,
        prRef: row.prRef,
        baseSha: row.baseSha,
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
  if (row.runId !== null) {
    const outcome = await ensureRunAndProjectInCloud(localDb, cloudDb, row.runId);
    if (outcome === 'local_only') return true; // parent chain is local-only — skip cloud insert
  }
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
  if (row.runId !== null) {
    const outcome = await ensureRunAndProjectInCloud(localDb, cloudDb, row.runId);
    if (outcome === 'local_only') return true; // parent chain is local-only — skip cloud insert
  }
  // policy_rules (and their parent policy) aren't synced to cloud in
  // v1 — admins seed them per-project locally via `coodra init`'s
  // 25-rule baseline, and there's no edit UI yet that would justify
  // cross-machine sync. Cloud's policy_decisions table has an FK on
  // matched_rule_id that would block every PreToolUse audit if we
  // pushed the local UUID. Null it out — the local row keeps the
  // reference for local audits, the cloud row records the decision
  // without the (cloud-meaningless) rule lineage. Reason text stays.
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
      matchedRuleId: null, // see comment above — cloud has no policy_rules yet.
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
  if (row.runId !== null) {
    const outcome = await ensureRunAndProjectInCloud(localDb, cloudDb, row.runId);
    if (outcome === 'local_only') return true; // parent chain is local-only — skip cloud insert
  }
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
      // M05 / M04 Phase 4 — see schema/sqlite.ts::decisions. Note that
      // `source` and `meta` live on context_packs only, not on decisions
      // — the M05 reshape only added context/impact/confidence/reversible
      // here. Don't copy-paste those from syncContextPacks.
      context: row.context,
      impact: row.impact,
      confidence: row.confidence,
      reversible: row.reversible,
      createdByUserId: row.createdByUserId,
    })
    .onConflictDoNothing({ target: postgresSchema.decisions.idempotencyKey });
  log.debug({ event: 'sync_decisions_pushed', jobId, key: row.idempotencyKey }, 'decisions row synced');
  return true;
}

/**
 * Phase F.1 — features push.
 *
 * Looks up the local SQLite features row by id, then upserts the cloud
 * Postgres row. ON CONFLICT (project_id, slug) DO UPDATE so re-publish
 * of the same slug collapses cleanly. Status (draft/published) is part
 * of the synced state — admins can flip status in the web UI on either
 * side and have it converge.
 *
 * FK satisfaction: features.project_id → projects.id. Local-only orgs
 * (__solo__, __global__) bail early with a successful skip — no point
 * pushing features for a project the cloud doesn't have. This means a
 * solo-mode developer's features never leak into a team feed, even if
 * the queue accumulated stale jobs from a mode flip.
 *
 * Conflict resolution is last-write-wins by `updated_at`. The
 * concurrent-edit `.cloud.md` sidecar is the PULL-side concern (the
 * puller is what writes back to filesystem and can detect divergence
 * between the local file's mtime and the incoming cloud updatedAt).
 */
async function syncFeatures({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.features;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  // Phase H.1 — guarantee the parent project lands in cloud BEFORE the
  // features INSERT so the FK never violates due to job-claim ordering.
  // `ensureProjectInCloud` handles the local-only short-circuit too, so
  // the `shouldSkipLocalOnly` call below is redundant but kept for the
  // explicit log line (operators expect it). When the outcome is
  // `local_only`, treat the sync as a clean skip.
  const parentOutcome = await ensureProjectInCloud(localDb, cloudDb, row.projectId);
  if (parentOutcome === 'local_only') {
    log.info(
      { event: 'sync_features_skipped_local_only', jobId, featureId: row.id, projectId: row.projectId },
      'features row belongs to local-only project; skipping cloud push',
    );
    return true;
  }
  if (parentOutcome === 'missing') {
    log.warn(
      { event: 'sync_features_parent_missing', jobId, featureId: row.id, projectId: row.projectId },
      'features parent project missing locally; cannot satisfy FK',
    );
    return false; // caller treats as transient_failure
  }
  const ct = postgresSchema.features;
  await cloudDb.db
    .insert(ct)
    .values({
      id: row.id,
      projectId: row.projectId,
      slug: row.slug,
      frontmatter: row.frontmatter,
      body: row.body,
      checksum: row.checksum,
      status: row.status,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: [ct.projectId, ct.slug],
      set: {
        frontmatter: row.frontmatter,
        body: row.body,
        checksum: row.checksum,
        status: row.status,
        // Refresh updated_at to the local timestamp so the puller's
        // last-write-wins comparison reflects the latest mutation.
        updatedAt: row.updatedAt,
        createdByUserId: row.createdByUserId,
      },
    });
  log.debug(
    { event: 'sync_features_pushed', jobId, featureId: row.id, slug: row.slug, status: row.status },
    'features row pushed to cloud',
  );
  return true;
}

/**
 * Phase F.2 — feature_packs push.
 *
 * Mirrors `syncFeatures` for the module-blueprint layer. Lookup is by
 * `slug` (or `id`) since `feature_packs` is project-agnostic — slug is
 * globally unique by design (see `feature-pack.ts` comment). Pushes the
 * full `content_json` envelope so the cloud row carries the spec.md +
 * implementation.md + techstack.md + meta.json bundle in one place.
 *
 * ON CONFLICT (slug) DO UPDATE — re-publishing the same slug is an
 * idempotent update, not a duplicate. Same conflict-resolution pattern
 * as features: last-write-wins by `updated_at`; the puller's filesystem
 * writeback handles the local-mtime-vs-cloud-updated_at sidecar logic.
 *
 * No FK satisfaction needed — feature_packs doesn't reference projects.
 * (The "scope by project" question is open per the existing
 * `apps/mcp-server/src/lib/feature-pack.ts` comment; until that lands,
 * cloud sync is unscoped too.)
 */
async function syncFeaturePacks({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  const lt = sqliteSchema.featurePacks;
  let row: typeof lt.$inferSelect | undefined;
  if (lookup.kind === 'id') {
    row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  } else if (lookup.kind === 'idempotency_key') {
    // The CLI/web enqueue uses lookup={ kind: 'idempotency_key', value: slug }
    // because the slug IS the natural idempotent key for feature_packs.
    row = (await localDb.db.select().from(lt).where(eq(lt.slug, lookup.value)).limit(1))[0];
  } else {
    return false;
  }
  if (!row) return false;
  const ct = postgresSchema.featurePacks;
  await cloudDb.db
    .insert(ct)
    .values({
      id: row.id,
      slug: row.slug,
      parentSlug: row.parentSlug,
      isActive: row.isActive,
      checksum: row.checksum,
      createdByUserId: row.createdByUserId,
      contentJson: row.contentJson,
      status: row.status,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: [ct.slug],
      set: {
        parentSlug: row.parentSlug,
        isActive: row.isActive,
        checksum: row.checksum,
        contentJson: row.contentJson,
        status: row.status,
        createdByUserId: row.createdByUserId,
        updatedAt: row.updatedAt,
      },
    });
  log.debug(
    { event: 'sync_feature_packs_pushed', jobId, featurePackId: row.id, slug: row.slug, status: row.status },
    'feature_packs row pushed to cloud',
  );
  return true;
}

async function syncContextPacks({ localDb, cloudDb, lookup, log, jobId }: SyncOneArgs): Promise<boolean> {
  if (lookup.kind !== 'id') return false;
  const lt = sqliteSchema.contextPacks;
  const row = (await localDb.db.select().from(lt).where(eq(lt.id, lookup.value)).limit(1))[0];
  if (!row) return false;
  if (row.runId !== null) {
    const outcome = await ensureRunAndProjectInCloud(localDb, cloudDb, row.runId);
    if (outcome === 'local_only') return true; // parent chain is local-only — skip cloud insert
  }
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
      // M05 / M04 Phase 4 — see schema/sqlite.ts::contextPacks.
      source: row.source,
      meta: row.meta,
      createdByUserId: row.createdByUserId,
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
