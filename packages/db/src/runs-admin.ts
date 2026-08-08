import { and, asc, desc, eq, inArray, max, ne, notInArray, notLike } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/runs-admin` — admin-side helpers for the `runs`
 * table. Backs Module 08b S11's `coodra run {list, show, cancel}`
 * CLI surface.
 *
 * Per OQ-6 lock (2026-05-03), cancellation is informational metadata:
 * `cancelRun` flips `runs.status='cancelled'` + `ended_at=now()` and
 * nothing else. The bridge does NOT consult `runs.status` on the
 * latency-sensitive PostToolUse path; events that arrive AFTER cancel
 * still land in run_events. This keeps the bridge's hot path free of
 * an extra DB lookup; the CLI surface here is for human-readable
 * audit, not enforcement.
 *
 * `getRunWithEverything` bundles every per-run row from every audit
 * table so `run show <runId>` can render a complete picture without
 * the operator having to join 5 tables by hand.
 *
 * `contextPacks` is a full array, ordered oldest-first (fixed 2026-08-08 —
 * the append-only redesign (2026-08-05) made `context_packs` no longer
 * one-row-per-run, but this read path kept a stale `.limit(1)` with no
 * `orderBy`, silently returning an arbitrary single pack and discarding
 * the rest for any run that accumulated more than one — which a
 * long-running session spanning multiple distinct pieces of work
 * routinely does).
 */

export interface RunRow {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly mode: string;
  readonly status: string;
  readonly issueRef: string | null;
  readonly prRef: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

export interface RunEventRow {
  readonly id: string;
  readonly runId: string | null;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: string;
  readonly outcome: string | null;
  readonly createdAt: Date;
}

export interface PolicyDecisionRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly runId: string | null;
  readonly sessionId: string;
  readonly projectId: string;
  readonly agentType: string;
  readonly eventType: string;
  readonly toolName: string;
  readonly permissionDecision: string;
  readonly matchedRuleId: string | null;
  readonly reason: string;
  readonly createdAt: Date;
}

export interface DecisionRow {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly runId: string | null;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  /** M05 — what triggered this decision (user request, error, design review). */
  readonly context: string | null;
  /** M05 — JSON-encoded array of affected modules / API surfaces / files. */
  readonly impact: string | null;
  /** M05 — 'high' | 'medium' | 'low' | NULL. */
  readonly confidence: string | null;
  /** M05 — boolean stored nullable so legacy rows have no answer. */
  readonly reversible: boolean | null;
  /**
   * Module 04 Phase 4 — Clerk user id of the agent that recorded this
   * decision. NULL on solo + on pre-Phase-4 rows; web app's "decided by"
   * badge branches on null vs userId.
   */
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
}

export interface ContextPackRow {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly title: string;
  readonly contentExcerpt: string;
  /** M05 — 'agent' (canonical) | 'bridge_auto' (fallback floor). */
  readonly source: string;
  /** M05 — JSON-encoded agent-curated metadata. */
  readonly meta: string | null;
  /**
   * Module 04 Phase 4 — Clerk user id of the agent that wrote this pack.
   * NULL on solo + bridge_auto rows + pre-Phase-4 rows. The "authored by"
   * badge in the web app branches on null.
   */
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
}

export interface RunWithEverything {
  readonly run: RunRow;
  readonly events: ReadonlyArray<RunEventRow>;
  readonly policyDecisions: ReadonlyArray<PolicyDecisionRow>;
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly contextPacks: ReadonlyArray<ContextPackRow>;
}

export interface ListRunsFilter {
  readonly projectId?: string;
  readonly status?: string;
  readonly limit?: number;
  /**
   * Status values to exclude. When set together with `status` the
   * `status` equality wins. Used by the web app's default `/runs`
   * listing to hide `abandoned` (typically dev-test artifacts the
   * operator did not produce intentionally).
   */
  readonly excludeStatuses?: ReadonlyArray<string>;
  /**
   * Substring pattern to exclude from `session_id` (LIKE `%pattern%`).
   * Used to hide synthetic / probe sessions (e.g. doctor probes,
   * orphan-backfill sentinels) from the default listing without
   * deleting their rows.
   */
  readonly excludeSessionIdPattern?: string;
}

/**
 * Returns the most-recent runs (by started_at DESC), optionally
 * filtered by projectId and/or status. Default limit 20; max 1000.
 *
 * `excludeStatuses` and `excludeSessionIdPattern` are additive
 * negative filters — when set, rows matching them are dropped from
 * the result. Used by the web app to keep the default `/runs` view
 * clean while preserving the underlying audit data.
 */
export async function listRunsForProject(db: DbHandle, filter: ListRunsFilter = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 20), 1000);

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const conditions = [];
    if (filter.projectId !== undefined) conditions.push(eq(t.projectId, filter.projectId));
    if (filter.status !== undefined) conditions.push(eq(t.status, filter.status));
    if (filter.excludeStatuses !== undefined && filter.excludeStatuses.length > 0) {
      conditions.push(notInArray(t.status, filter.excludeStatuses as string[]));
    }
    if (filter.excludeSessionIdPattern !== undefined && filter.excludeSessionIdPattern.length > 0) {
      conditions.push(notLike(t.sessionId, `%${filter.excludeSessionIdPattern}%`));
    }
    const rows =
      conditions.length === 0
        ? await db.db.select().from(t).orderBy(desc(t.startedAt)).limit(limit)
        : await db.db
            .select()
            .from(t)
            .where(and(...conditions))
            .orderBy(desc(t.startedAt))
            .limit(limit);
    return rows.map(toRunRow);
  }

  const t = postgresSchema.runs;
  const conditions = [];
  if (filter.projectId !== undefined) conditions.push(eq(t.projectId, filter.projectId));
  if (filter.status !== undefined) conditions.push(eq(t.status, filter.status));
  if (filter.excludeStatuses !== undefined && filter.excludeStatuses.length > 0) {
    conditions.push(notInArray(t.status, filter.excludeStatuses as string[]));
  }
  if (filter.excludeSessionIdPattern !== undefined && filter.excludeSessionIdPattern.length > 0) {
    conditions.push(notLike(t.sessionId, `%${filter.excludeSessionIdPattern}%`));
  }
  const rows =
    conditions.length === 0
      ? await db.db.select().from(t).orderBy(desc(t.startedAt)).limit(limit)
      : await db.db
          .select()
          .from(t)
          .where(and(...conditions))
          .orderBy(desc(t.startedAt))
          .limit(limit);
  return rows.map(toRunRow);
}

/**
 * Returns one run with every related row attached. Used by `run show`.
 * Returns null when no run matches.
 */
export async function getRunWithEverything(db: DbHandle, runId: string): Promise<RunWithEverything | null> {
  if (runId.length === 0) return null;

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const runs = await db.db.select().from(t).where(eq(t.id, runId)).limit(1);
    if (runs.length === 0) return null;
    const runRow = runs[0];
    if (runRow === undefined) return null;
    const run = toRunRow(runRow);

    const events = await db.db
      .select()
      .from(sqliteSchema.runEvents)
      .where(eq(sqliteSchema.runEvents.runId, runId))
      .orderBy(asc(sqliteSchema.runEvents.createdAt));
    const policyDecisions = await db.db
      .select()
      .from(sqliteSchema.policyDecisions)
      .where(eq(sqliteSchema.policyDecisions.runId, runId))
      .orderBy(asc(sqliteSchema.policyDecisions.createdAt));
    const decisions = await db.db
      .select()
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.runId, runId))
      .orderBy(asc(sqliteSchema.decisions.createdAt));
    const contextPacks = await db.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .orderBy(asc(sqliteSchema.contextPacks.createdAt));

    return {
      run,
      events: events.map(toEventRow),
      policyDecisions: policyDecisions.map(toPolicyDecisionRow),
      decisions: decisions.map(toDecisionRow),
      contextPacks: contextPacks.map(toContextPackRow),
    };
  }

  const t = postgresSchema.runs;
  const runs = await db.db.select().from(t).where(eq(t.id, runId)).limit(1);
  if (runs.length === 0) return null;
  const runRow = runs[0];
  if (runRow === undefined) return null;
  const run = toRunRow(runRow);
  const events = await db.db
    .select()
    .from(postgresSchema.runEvents)
    .where(eq(postgresSchema.runEvents.runId, runId))
    .orderBy(asc(postgresSchema.runEvents.createdAt));
  const policyDecisions = await db.db
    .select()
    .from(postgresSchema.policyDecisions)
    .where(eq(postgresSchema.policyDecisions.runId, runId))
    .orderBy(asc(postgresSchema.policyDecisions.createdAt));
  const decisions = await db.db
    .select()
    .from(postgresSchema.decisions)
    .where(eq(postgresSchema.decisions.runId, runId))
    .orderBy(asc(postgresSchema.decisions.createdAt));
  const contextPacks = await db.db
    .select()
    .from(postgresSchema.contextPacks)
    .where(eq(postgresSchema.contextPacks.runId, runId))
    .orderBy(asc(postgresSchema.contextPacks.createdAt));

  return {
    run,
    events: events.map(toEventRow),
    policyDecisions: policyDecisions.map(toPolicyDecisionRow),
    decisions: decisions.map(toDecisionRow),
    contextPacks: contextPacks.map(toContextPackRow),
  };
}

/**
 * Last-activity timestamp per run, derived from `MAX(run_events.created_at)`
 * — no dedicated `runs.updated_at` column exists, and none is needed: a
 * run's own `started_at`/`ended_at` don't move as activity continues
 * (`ended_at` is only ever set once, by `SessionEnd`/cancel/complete —
 * see `getRunIdHandler`'s reuse path for why a run can keep recording
 * events for days after that), so the web app's "Updated" display reads
 * this instead. Batched (one aggregate query, not N) for the runs-list
 * page; empty input short-circuits without a round-trip.
 */
export async function getLastEventAtForRuns(
  db: DbHandle,
  runIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Date>> {
  if (runIds.length === 0) return new Map();

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runEvents;
    const rows = await db.db
      .select({ runId: t.runId, lastAt: max(t.createdAt) })
      .from(t)
      .where(inArray(t.runId, runIds as string[]))
      .groupBy(t.runId);
    const out = new Map<string, Date>();
    for (const row of rows) {
      if (row.runId !== null && row.lastAt !== null) out.set(row.runId, row.lastAt);
    }
    return out;
  }

  const t = postgresSchema.runEvents;
  const rows = await db.db
    .select({ runId: t.runId, lastAt: max(t.createdAt) })
    .from(t)
    .where(inArray(t.runId, runIds as string[]))
    .groupBy(t.runId);
  const out = new Map<string, Date>();
  for (const row of rows) {
    if (row.runId !== null && row.lastAt !== null) out.set(row.runId, row.lastAt);
  }
  return out;
}

export type CancelRunResult =
  | { readonly status: 'cancelled'; readonly run: RunRow }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_terminal'; readonly run: RunRow };

/**
 * Mark a run as cancelled. Per OQ-6 (lock 2026-05-03):
 *   - Sets `status='cancelled'` + `ended_at=now()`.
 *   - Does NOT block future events for this run; the bridge keeps
 *     accepting PostToolUse / SessionEnd events. Cancellation is
 *     informational metadata, not enforcement.
 *
 * Idempotency: cancelling an already-cancelled run returns
 * `{ status: 'already_terminal' }`. Cancelling a `completed` /
 * `failed` / `abandoned` run also returns `already_terminal` (the
 * status is already final). The CLI maps `already_terminal` to exit 2.
 */
export async function cancelRun(db: DbHandle, runId: string, now: Date = new Date()): Promise<CancelRunResult> {
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await db.db.select().from(t).where(eq(t.id, runId)).limit(1);
    if (rows.length === 0) return { status: 'not_found' };
    const row = rows[0];
    if (row === undefined) return { status: 'not_found' };
    if (row.status !== 'in_progress') {
      return { status: 'already_terminal', run: toRunRow(row) };
    }
    await db.db.update(t).set({ status: 'cancelled', endedAt: now }).where(eq(t.id, runId));
    const after = await db.db.select().from(t).where(eq(t.id, runId)).limit(1);
    const updated = after[0];
    if (updated === undefined) return { status: 'not_found' };
    return { status: 'cancelled', run: toRunRow(updated) };
  }

  const t = postgresSchema.runs;
  const rows = await db.db.select().from(t).where(eq(t.id, runId)).limit(1);
  if (rows.length === 0) return { status: 'not_found' };
  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (row.status !== 'in_progress') {
    return { status: 'already_terminal', run: toRunRow(row) };
  }
  const updated = await db.db.update(t).set({ status: 'cancelled', endedAt: now }).where(eq(t.id, runId)).returning();
  const after = updated[0];
  if (after === undefined) return { status: 'not_found' };
  return { status: 'cancelled', run: toRunRow(after) };
}

/**
 * Mark a run completed. Idempotent (guarded so an already-`completed`
 * row isn't re-touched), same shape as `cancelRun`'s update. Shared
 * between `save_context_pack`'s own completion side-effect and the
 * `lifecycle_event` handler's `SessionEnd` case (Claude Code hook
 * coverage expansion, 2026-08-04) — previously `save-context-pack/
 * handler.ts` had a private copy of this; that path now calls this one.
 */
export async function markRunCompleted(db: DbHandle, runId: string, now: Date = new Date()): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.runs)
      .set({ status: 'completed', endedAt: now })
      .where(and(eq(sqliteSchema.runs.id, runId), ne(sqliteSchema.runs.status, 'completed')));
    return;
  }
  await db.db
    .update(postgresSchema.runs)
    .set({ status: 'completed', endedAt: now })
    .where(and(eq(postgresSchema.runs.id, runId), ne(postgresSchema.runs.status, 'completed')));
}

/**
 * Mark a run failed — the `StopFailure` case (an API-level error ended
 * the turn: rate limit, auth failure, server error, ...), as opposed to
 * a normal `Stop`/`SessionEnd`. The `'failed'` status value already
 * existed in the schema/query enum before this but nothing ever wrote
 * it (added 2026-08-04 alongside the `lifecycle_event` handler's new
 * `StopFailure` branch). `errorType`/`errorMessage` aren't persisted on
 * this row — there's no column for them — callers should also record
 * them via the run-event ledger for the activity trail; this only
 * flips status so the run doesn't dangle `in_progress` forever.
 */
export async function markRunFailed(db: DbHandle, runId: string, now: Date = new Date()): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.runs)
      .set({ status: 'failed', endedAt: now })
      .where(and(eq(sqliteSchema.runs.id, runId), ne(sqliteSchema.runs.status, 'failed')));
    return;
  }
  await db.db
    .update(postgresSchema.runs)
    .set({ status: 'failed', endedAt: now })
    .where(and(eq(postgresSchema.runs.id, runId), ne(postgresSchema.runs.status, 'failed')));
}

/**
 * Whether a `context_packs` row exists for `runId` (the column is
 * uniquely indexed — at most one). Used by `PreCompact`'s one-shot
 * nudge to decide whether there's anything still unsaved worth
 * blocking compaction for.
 */
export async function hasContextPackForRun(db: DbHandle, runId: string): Promise<boolean> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.contextPacks.id })
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1);
    return rows.length > 0;
  }
  const rows = await db.db
    .select({ id: postgresSchema.contextPacks.id })
    .from(postgresSchema.contextPacks)
    .where(eq(postgresSchema.contextPacks.runId, runId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether a `SessionStart` row has ever been recorded to `run_events`
 * for this run. `lifecycle_event`'s handler records every hook event it
 * sees (including `SessionStart` itself, under `toolName: 'SessionStart'`
 * — see `RunRecorder.record`'s `toolName` fallback) regardless of
 * `hookEventName`, so this is a real, always-populated signal rather than
 * a synthetic flag — used to give `UserPromptSubmit` a session-contract
 * fallback when the agent's own `SessionStart` hook never fired for this
 * run (e.g. Codex Desktop's plugin-hook trust gate skipping it; Cursor,
 * which has no `SessionStart` event at all).
 */
export async function hasSessionStartEventForRun(db: DbHandle, runId: string): Promise<boolean> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.runEvents.id })
      .from(sqliteSchema.runEvents)
      .where(and(eq(sqliteSchema.runEvents.runId, runId), eq(sqliteSchema.runEvents.toolName, 'SessionStart')))
      .limit(1);
    return rows.length > 0;
  }
  const rows = await db.db
    .select({ id: postgresSchema.runEvents.id })
    .from(postgresSchema.runEvents)
    .where(and(eq(postgresSchema.runEvents.runId, runId), eq(postgresSchema.runEvents.toolName, 'SessionStart')))
    .limit(1);
  return rows.length > 0;
}

/**
 * Reads `runs.compactionNudgedAt` — null means "PreCompact hasn't
 * blocked compaction for this run yet." See `markRunCompactionNudged`.
 */
export async function getRunCompactionNudgedAt(db: DbHandle, runId: string): Promise<Date | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ compactionNudgedAt: sqliteSchema.runs.compactionNudgedAt })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.compactionNudgedAt ?? null;
  }
  const rows = await db.db
    .select({ compactionNudgedAt: postgresSchema.runs.compactionNudgedAt })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.compactionNudgedAt ?? null;
}

/**
 * Sets `runs.compactionNudgedAt` — the `lifecycle_event` handler's
 * `PreCompact` case calls this the first time it blocks compaction to
 * nudge the agent to save unsaved decisions/context, so a later
 * `PreCompact` call for the same run allows compaction unconditionally
 * instead of blocking repeatedly.
 */
export async function markRunCompactionNudged(db: DbHandle, runId: string, now: Date = new Date()): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.runs).set({ compactionNudgedAt: now }).where(eq(sqliteSchema.runs.id, runId));
    return;
  }
  await db.db.update(postgresSchema.runs).set({ compactionNudgedAt: now }).where(eq(postgresSchema.runs.id, runId));
}

// ============================================================================
// Coercion helpers — the SQLite + Postgres $inferSelect rows have the same
// shape (Drizzle returns Date for both timestamp variants), but TS can't
// always prove that, so we narrow explicitly.
// ============================================================================

interface RawRunRow {
  id: string;
  projectId: string;
  sessionId: string;
  agentType: string;
  mode: string;
  status: string;
  issueRef: string | null;
  prRef: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

interface RawEventRow {
  id: string;
  runId: string | null;
  phase: string;
  toolName: string;
  toolUseId: string;
  toolInput: string;
  outcome: string | null;
  createdAt: Date;
}

interface RawPolicyDecisionRow {
  id: string;
  idempotencyKey: string;
  runId: string | null;
  sessionId: string;
  projectId: string;
  agentType: string;
  eventType: string;
  toolName: string;
  permissionDecision: string;
  matchedRuleId: string | null;
  reason: string;
  createdAt: Date;
}

interface RawDecisionRow {
  id: string;
  idempotencyKey: string;
  runId: string | null;
  description: string;
  rationale: string;
  alternatives: string | null;
  context: string | null;
  impact: string | null;
  confidence: string | null;
  reversible: boolean | null;
  createdByUserId: string | null;
  createdAt: Date;
}

interface RawContextPackRow {
  id: string;
  runId: string;
  projectId: string;
  title: string;
  contentExcerpt: string;
  source: string;
  meta: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

function toRunRow(r: unknown): RunRow {
  const row = r as RawRunRow;
  return {
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
  };
}

function toEventRow(r: unknown): RunEventRow {
  const row = r as RawEventRow;
  return {
    id: row.id,
    runId: row.runId,
    phase: row.phase,
    toolName: row.toolName,
    toolUseId: row.toolUseId,
    toolInput: row.toolInput,
    outcome: row.outcome,
    createdAt: row.createdAt,
  };
}

function toPolicyDecisionRow(r: unknown): PolicyDecisionRow {
  const row = r as RawPolicyDecisionRow;
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    runId: row.runId,
    sessionId: row.sessionId,
    projectId: row.projectId,
    agentType: row.agentType,
    eventType: row.eventType,
    toolName: row.toolName,
    permissionDecision: row.permissionDecision,
    matchedRuleId: row.matchedRuleId,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function toDecisionRow(r: unknown): DecisionRow {
  const row = r as RawDecisionRow;
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    runId: row.runId,
    description: row.description,
    rationale: row.rationale,
    alternatives: row.alternatives,
    context: row.context ?? null,
    impact: row.impact ?? null,
    confidence: row.confidence ?? null,
    reversible: row.reversible ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

function toContextPackRow(r: unknown): ContextPackRow {
  const row = r as RawContextPackRow;
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    title: row.title,
    contentExcerpt: row.contentExcerpt,
    source: row.source ?? 'agent',
    meta: row.meta ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Context-pack list / detail helpers (M04 Phase 2 S7 + S9)
// ---------------------------------------------------------------------------

export interface ListContextPacksFilter {
  readonly projectId: string;
  readonly limit?: number;
}

/**
 * Lists context packs for a project, newest first. Excerpt-only — the
 * full body is read on demand via `getContextPackById`. Default limit
 * 50, max 1000.
 */
export async function listContextPacksForProject(
  db: DbHandle,
  filter: ListContextPacksFilter,
): Promise<ContextPackRow[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 1000);
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.contextPacks;
    const rows = await db.db
      .select()
      .from(t)
      .where(eq(t.projectId, filter.projectId))
      .orderBy(desc(t.createdAt))
      .limit(limit);
    return rows.map(toContextPackRow);
  }
  const t = postgresSchema.contextPacks;
  const rows = await db.db
    .select()
    .from(t)
    .where(eq(t.projectId, filter.projectId))
    .orderBy(desc(t.createdAt))
    .limit(limit);
  return rows.map(toContextPackRow);
}

export interface ContextPackDetailRow extends ContextPackRow {
  /** Full body (not just excerpt). */
  readonly content: string;
}

interface RawContextPackDetailRow extends RawContextPackRow {
  content: string;
}

function toContextPackDetailRow(r: unknown): ContextPackDetailRow {
  const row = r as RawContextPackDetailRow;
  return {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    title: row.title,
    contentExcerpt: row.contentExcerpt,
    content: row.content,
    source: row.source ?? 'agent',
    meta: row.meta ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Workspace-level listers (M05 follow-up — workspace decisions + packs UI)
// ---------------------------------------------------------------------------

/**
 * `decisions` row joined to its run's `project_id` (and, since
 * 2026-08-08, `agent_type`) so the web app can group / filter by
 * project and show which agent recorded the decision without a second
 * query. The decision's runId can be NULL (decisions outlive their runs
 * via ON DELETE SET NULL — ADR-007 spirit), so the projectId/agentType
 * come from the join only when runId is set.
 */
export interface DecisionWithProject extends DecisionRow {
  readonly projectId: string | null;
  readonly projectSlug: string | null;
  readonly agentType: string | null;
}

export interface ListDecisionsFilter {
  readonly projectId?: string;
  readonly limit?: number;
}

export async function listAllDecisions(db: DbHandle, filter: ListDecisionsFilter = {}): Promise<DecisionWithProject[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);

  if (db.kind === 'sqlite') {
    const d = sqliteSchema.decisions;
    const r = sqliteSchema.runs;
    const p = sqliteSchema.projects;
    const baseQuery = db.db
      .select({
        id: d.id,
        idempotencyKey: d.idempotencyKey,
        runId: d.runId,
        description: d.description,
        rationale: d.rationale,
        alternatives: d.alternatives,
        context: d.context,
        impact: d.impact,
        confidence: d.confidence,
        reversible: d.reversible,
        createdByUserId: d.createdByUserId,
        createdAt: d.createdAt,
        projectId: r.projectId,
        projectSlug: p.slug,
        agentType: r.agentType,
      })
      .from(d)
      .leftJoin(r, eq(r.id, d.runId))
      .leftJoin(p, eq(p.id, r.projectId));
    const rows =
      filter.projectId !== undefined
        ? await baseQuery.where(eq(r.projectId, filter.projectId)).orderBy(desc(d.createdAt)).limit(limit)
        : await baseQuery.orderBy(desc(d.createdAt)).limit(limit);
    return rows.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotencyKey,
      runId: row.runId,
      description: row.description,
      rationale: row.rationale,
      alternatives: row.alternatives,
      context: row.context,
      impact: row.impact,
      confidence: row.confidence,
      reversible: row.reversible,
      createdByUserId: row.createdByUserId ?? null,
      createdAt: row.createdAt,
      projectId: row.projectId,
      projectSlug: row.projectSlug,
      agentType: row.agentType ?? null,
    }));
  }
  const d = postgresSchema.decisions;
  const r = postgresSchema.runs;
  const p = postgresSchema.projects;
  const baseQuery = db.db
    .select({
      id: d.id,
      idempotencyKey: d.idempotencyKey,
      runId: d.runId,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives,
      context: d.context,
      impact: d.impact,
      confidence: d.confidence,
      reversible: d.reversible,
      createdByUserId: d.createdByUserId,
      createdAt: d.createdAt,
      projectId: r.projectId,
      projectSlug: p.slug,
      agentType: r.agentType,
    })
    .from(d)
    .leftJoin(r, eq(r.id, d.runId))
    .leftJoin(p, eq(p.id, r.projectId));
  const rows =
    filter.projectId !== undefined
      ? await baseQuery.where(eq(r.projectId, filter.projectId)).orderBy(desc(d.createdAt)).limit(limit)
      : await baseQuery.orderBy(desc(d.createdAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    runId: row.runId,
    description: row.description,
    rationale: row.rationale,
    alternatives: row.alternatives,
    context: row.context,
    impact: row.impact,
    confidence: row.confidence,
    reversible: row.reversible,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
    projectId: row.projectId,
    projectSlug: row.projectSlug,
    agentType: row.agentType ?? null,
  }));
}

/**
 * Single decision by id, same shape/join as `listAllDecisions` — backs
 * the `/decisions/[id]` detail page, which needs the full untruncated
 * row (the list view only ever shows an excerpt).
 */
export async function getDecisionById(db: DbHandle, id: string): Promise<DecisionWithProject | null> {
  if (id.length === 0) return null;

  if (db.kind === 'sqlite') {
    const d = sqliteSchema.decisions;
    const r = sqliteSchema.runs;
    const p = sqliteSchema.projects;
    const rows = await db.db
      .select({
        id: d.id,
        idempotencyKey: d.idempotencyKey,
        runId: d.runId,
        description: d.description,
        rationale: d.rationale,
        alternatives: d.alternatives,
        context: d.context,
        impact: d.impact,
        confidence: d.confidence,
        reversible: d.reversible,
        createdByUserId: d.createdByUserId,
        createdAt: d.createdAt,
        projectId: r.projectId,
        projectSlug: p.slug,
        agentType: r.agentType,
      })
      .from(d)
      .leftJoin(r, eq(r.id, d.runId))
      .leftJoin(p, eq(p.id, r.projectId))
      .where(eq(d.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { ...row, createdByUserId: row.createdByUserId ?? null, agentType: row.agentType ?? null };
  }

  const d = postgresSchema.decisions;
  const r = postgresSchema.runs;
  const p = postgresSchema.projects;
  const rows = await db.db
    .select({
      id: d.id,
      idempotencyKey: d.idempotencyKey,
      runId: d.runId,
      description: d.description,
      rationale: d.rationale,
      alternatives: d.alternatives,
      context: d.context,
      impact: d.impact,
      confidence: d.confidence,
      reversible: d.reversible,
      createdByUserId: d.createdByUserId,
      createdAt: d.createdAt,
      projectId: r.projectId,
      projectSlug: p.slug,
      agentType: r.agentType,
    })
    .from(d)
    .leftJoin(r, eq(r.id, d.runId))
    .leftJoin(p, eq(p.id, r.projectId))
    .where(eq(d.id, id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return { ...row, createdByUserId: row.createdByUserId ?? null, agentType: row.agentType ?? null };
}

/**
 * Context packs across a batch of runs — backs the decision list/detail
 * pages' reverse lookup ("which pack(s) linked this decision via
 * `meta.decisionIds`?"). Unordered; callers group/sort as needed. Empty
 * input short-circuits without a round-trip, same convention as
 * `getLastEventAtForRuns`.
 */
export async function listContextPacksForRuns(db: DbHandle, runIds: ReadonlyArray<string>): Promise<ContextPackRow[]> {
  if (runIds.length === 0) return [];

  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(inArray(sqliteSchema.contextPacks.runId, runIds as string[]));
    return rows.map(toContextPackRow);
  }
  const rows = await db.db
    .select()
    .from(postgresSchema.contextPacks)
    .where(inArray(postgresSchema.contextPacks.runId, runIds as string[]));
  return rows.map(toContextPackRow);
}

/**
 * Workspace-level Context Pack listing — across all projects, joined to
 * the project slug for the UI's project chip. Mirrors `listAllDecisions`.
 */
export interface ContextPackWithProject extends ContextPackRow {
  readonly projectSlug: string | null;
}

export interface ListAllContextPacksFilter {
  readonly projectId?: string;
  readonly source?: 'agent' | 'bridge_auto';
  readonly limit?: number;
}

export async function listAllContextPacks(
  db: DbHandle,
  filter: ListAllContextPacksFilter = {},
): Promise<ContextPackWithProject[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);

  if (db.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const p = sqliteSchema.projects;
    const conditions = [];
    if (filter.projectId !== undefined) conditions.push(eq(cp.projectId, filter.projectId));
    if (filter.source !== undefined) conditions.push(eq(cp.source, filter.source));
    const baseQuery = db.db
      .select({
        id: cp.id,
        runId: cp.runId,
        projectId: cp.projectId,
        title: cp.title,
        contentExcerpt: cp.contentExcerpt,
        source: cp.source,
        meta: cp.meta,
        createdByUserId: cp.createdByUserId,
        createdAt: cp.createdAt,
        projectSlug: p.slug,
      })
      .from(cp)
      .leftJoin(p, eq(p.id, cp.projectId));
    const rows =
      conditions.length === 0
        ? await baseQuery.orderBy(desc(cp.createdAt)).limit(limit)
        : await baseQuery
            .where(and(...conditions))
            .orderBy(desc(cp.createdAt))
            .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      projectId: row.projectId,
      title: row.title,
      contentExcerpt: row.contentExcerpt,
      source: row.source ?? 'agent',
      meta: row.meta ?? null,
      createdByUserId: row.createdByUserId ?? null,
      createdAt: row.createdAt,
      projectSlug: row.projectSlug,
    }));
  }
  const cp = postgresSchema.contextPacks;
  const p = postgresSchema.projects;
  const conditions = [];
  if (filter.projectId !== undefined) conditions.push(eq(cp.projectId, filter.projectId));
  if (filter.source !== undefined) conditions.push(eq(cp.source, filter.source));
  const baseQuery = db.db
    .select({
      id: cp.id,
      runId: cp.runId,
      projectId: cp.projectId,
      title: cp.title,
      contentExcerpt: cp.contentExcerpt,
      source: cp.source,
      meta: cp.meta,
      createdByUserId: cp.createdByUserId,
      createdAt: cp.createdAt,
      projectSlug: p.slug,
    })
    .from(cp)
    .leftJoin(p, eq(p.id, cp.projectId));
  const rows =
    conditions.length === 0
      ? await baseQuery.orderBy(desc(cp.createdAt)).limit(limit)
      : await baseQuery
          .where(and(...conditions))
          .orderBy(desc(cp.createdAt))
          .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    title: row.title,
    contentExcerpt: row.contentExcerpt,
    source: row.source ?? 'agent',
    meta: row.meta ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
    projectSlug: row.projectSlug,
  }));
}

/**
 * `audit_events` joined to its project slug — the append-only
 * tamper-evident stream (`packages/db/src/audit-events.ts::
 * insertAuditEvent`) that records policy/kill-switch changes and
 * privileged tool-call outcomes, distinct from the state tables
 * (`decisions`, `context_packs`) that only hold current truth. Mirrors
 * `ContextPackWithProject`/`DecisionWithProject`.
 */
export interface AuditEventWithProject {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly actorUserId: string | null;
  readonly actorRunId: string | null;
  readonly eventType: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly action: string;
  readonly result: string;
  readonly reason: string | null;
  readonly metadataJson: string;
  readonly createdAt: Date;
  readonly projectSlug: string | null;
}

export interface ListAuditEventsFilter {
  readonly projectId?: string;
  readonly limit?: number;
}

export async function listAllAuditEvents(
  db: DbHandle,
  filter: ListAuditEventsFilter = {},
): Promise<AuditEventWithProject[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);

  if (db.kind === 'sqlite') {
    const ae = sqliteSchema.auditEvents;
    const p = sqliteSchema.projects;
    const baseQuery = db.db
      .select({
        id: ae.id,
        orgId: ae.orgId,
        projectId: ae.projectId,
        runId: ae.runId,
        actorUserId: ae.actorUserId,
        actorRunId: ae.actorRunId,
        eventType: ae.eventType,
        subjectTable: ae.subjectTable,
        subjectId: ae.subjectId,
        action: ae.action,
        result: ae.result,
        reason: ae.reason,
        metadataJson: ae.metadataJson,
        createdAt: ae.createdAt,
        projectSlug: p.slug,
      })
      .from(ae)
      .leftJoin(p, eq(p.id, ae.projectId));
    const rows =
      filter.projectId !== undefined
        ? await baseQuery.where(eq(ae.projectId, filter.projectId)).orderBy(desc(ae.createdAt)).limit(limit)
        : await baseQuery.orderBy(desc(ae.createdAt)).limit(limit);
    return rows.map((row) => ({ ...row, projectId: row.projectId ?? null }));
  }
  const ae = postgresSchema.auditEvents;
  const p = postgresSchema.projects;
  const baseQuery = db.db
    .select({
      id: ae.id,
      orgId: ae.orgId,
      projectId: ae.projectId,
      runId: ae.runId,
      actorUserId: ae.actorUserId,
      actorRunId: ae.actorRunId,
      eventType: ae.eventType,
      subjectTable: ae.subjectTable,
      subjectId: ae.subjectId,
      action: ae.action,
      result: ae.result,
      reason: ae.reason,
      metadataJson: ae.metadataJson,
      createdAt: ae.createdAt,
      projectSlug: p.slug,
    })
    .from(ae)
    .leftJoin(p, eq(p.id, ae.projectId));
  const rows =
    filter.projectId !== undefined
      ? await baseQuery.where(eq(ae.projectId, filter.projectId)).orderBy(desc(ae.createdAt)).limit(limit)
      : await baseQuery.orderBy(desc(ae.createdAt)).limit(limit);
  return rows.map((row) => ({ ...row, projectId: row.projectId ?? null }));
}

/**
 * Returns one context pack with full body, or null when no row matches.
 * Used by /projects/[slug]/context-packs/[id].
 */
export async function getContextPackById(db: DbHandle, id: string): Promise<ContextPackDetailRow | null> {
  if (id.length === 0) return null;
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.contextPacks;
    const rows = await db.db.select().from(t).where(eq(t.id, id)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return row === undefined ? null : toContextPackDetailRow(row);
  }
  const t = postgresSchema.contextPacks;
  const rows = await db.db.select().from(t).where(eq(t.id, id)).limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  return row === undefined ? null : toContextPackDetailRow(row);
}
