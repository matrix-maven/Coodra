import { and, asc, desc, eq } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/runs-admin` — admin-side helpers for the `runs`
 * table. Backs Module 08b S11's `contextos run {list, show, cancel}`
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
  readonly createdAt: Date;
}

export interface ContextPackRow {
  readonly id: string;
  readonly runId: string;
  readonly projectId: string;
  readonly title: string;
  readonly contentExcerpt: string;
  readonly createdAt: Date;
}

export interface RunWithEverything {
  readonly run: RunRow;
  readonly events: ReadonlyArray<RunEventRow>;
  readonly policyDecisions: ReadonlyArray<PolicyDecisionRow>;
  readonly decisions: ReadonlyArray<DecisionRow>;
  readonly contextPack: ContextPackRow | null;
}

export interface ListRunsFilter {
  readonly projectId?: string;
  readonly status?: string;
  readonly limit?: number;
}

/**
 * Returns the most-recent runs (by started_at DESC), optionally
 * filtered by projectId and/or status. Default limit 20; max 1000.
 */
export async function listRunsForProject(db: DbHandle, filter: ListRunsFilter = {}): Promise<RunRow[]> {
  const limit = Math.min(Math.max(1, filter.limit ?? 20), 1000);

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const conditions = [];
    if (filter.projectId !== undefined) conditions.push(eq(t.projectId, filter.projectId));
    if (filter.status !== undefined) conditions.push(eq(t.status, filter.status));
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
      .limit(1);
    const contextPack = contextPacks[0];

    return {
      run,
      events: events.map(toEventRow),
      policyDecisions: policyDecisions.map(toPolicyDecisionRow),
      decisions: decisions.map(toDecisionRow),
      contextPack: contextPack === undefined ? null : toContextPackRow(contextPack),
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
    .limit(1);
  const contextPack = contextPacks[0];

  return {
    run,
    events: events.map(toEventRow),
    policyDecisions: policyDecisions.map(toPolicyDecisionRow),
    decisions: decisions.map(toDecisionRow),
    contextPack: contextPack === undefined ? null : toContextPackRow(contextPack),
  };
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
  createdAt: Date;
}

interface RawContextPackRow {
  id: string;
  runId: string;
  projectId: string;
  title: string;
  contentExcerpt: string;
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
    createdAt: row.createdAt,
  };
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
