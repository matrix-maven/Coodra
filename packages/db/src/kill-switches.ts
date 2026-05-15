import { randomUUID } from 'node:crypto';

import { createLogger } from '@coodra/shared';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/kill-switches` — runtime helpers for the
 * `kill_switches` table introduced in M08b S1 (migration `0007_*`).
 *
 * These functions back two consumer surfaces:
 *
 *   - `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts` (M08b S2)
 *     consults `listActiveKillSwitches` on every PreToolUse (cached
 *     5s) and runs `findKillSwitchMatchingEvent` against the result
 *     to decide deny / allow-with-audit / fall-through.
 *
 *   - `packages/cli/src/commands/{pause,resume}.ts` (M08b S3) calls
 *     `insertKillSwitch` / `softResumeKillSwitch` /
 *     `softResumeAllKillSwitches` for the operator surface.
 *
 * Locked decisions in play (see `docs/feature-packs/08b-cli-expansion/spec.md` §11):
 *
 *   - OQ-1: `mode` defaults to `'hard'`. The schema enforces this via
 *     a column default; `insertKillSwitch` does NOT pass `mode` if the
 *     caller omits it, letting the default apply.
 *
 *   - OQ-2: Polymorphic `(scope, target)` shape. The bridge's match
 *     query in `listActiveKillSwitches` filters at the SQL layer for
 *     `scope='global'` + `(scope='project' AND target=?)` rows; rows
 *     with `scope='tool'` and `scope='agent_type'` come back too
 *     (their target is the tool name / agent type, which we don't
 *     filter at SQL because the cardinality is unbounded). The
 *     in-memory `findKillSwitchMatchingEvent` narrows to the actual
 *     event.
 *
 *   - OQ-8: Local-only in M08b. None of these helpers enqueue a
 *     sync_to_cloud job — the kill-switch state never leaves the
 *     local SQLite store. M04 owns the cross-developer sync surface.
 *
 * Soft-resume (per spec §6 acceptance #11): `resumed_at IS NULL` is
 * the canonical "active" predicate. Resume sets `resumed_at` and
 * `resumed_by_session_id`; the row stays in the table as audit
 * history (parallels ADR-007's append-only spirit). The
 * `kill_switches_active_idx` on `(resumed_at, scope, target)`
 * partitions active vs history at the leading column.
 *
 * Failure-mode discipline: every helper throws on DB error. The
 * bridge catches and fails-open per system-architecture.md §7;
 * the CLI surfaces the error verbatim and exits non-zero.
 */

const killSwitchLogger = createLogger('db.kill-switches');

export const KILL_SWITCH_SCOPES = ['global', 'project', 'tool', 'agent_type'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const KILL_SWITCH_MODES = ['hard', 'soft'] as const;
export type KillSwitchMode = (typeof KILL_SWITCH_MODES)[number];

/**
 * Canonical row shape returned to consumers. Independent of dialect
 * — the SQLite and Postgres `$inferSelect` types differ only in how
 * Drizzle returns dates (both return `Date` objects via the schema's
 * `mode: 'timestamp' | 'date'`), so this interface unifies them.
 */
export interface KillSwitchRecord {
  readonly id: string;
  readonly scope: KillSwitchScope;
  readonly target: string | null;
  readonly mode: KillSwitchMode;
  readonly reason: string;
  readonly pausedAt: Date;
  readonly pausedBySessionId: string | null;
  readonly expiresAt: Date | null;
  readonly resumedAt: Date | null;
  readonly resumedBySessionId: string | null;
}

export interface InsertKillSwitchInput {
  readonly scope: KillSwitchScope;
  /** null when scope='global'; required (non-empty string) for project/tool/agent_type. */
  readonly target: string | null;
  /** Defaults to 'hard' (OQ-1 lock) when undefined. */
  readonly mode?: KillSwitchMode;
  readonly reason: string;
  readonly pausedBySessionId?: string | null;
  readonly expiresAt?: Date | null;
}

/**
 * Loose row shape both Drizzle dialects produce for kill_switches.
 * Used internally to coerce `$inferSelect` into the canonical
 * `KillSwitchRecord` shape returned to callers.
 */
type RawKillSwitchRow = {
  id: string;
  scope: string;
  target: string | null;
  mode: string;
  reason: string;
  pausedAt: Date;
  pausedBySessionId: string | null;
  expiresAt: Date | null;
  resumedAt: Date | null;
  resumedBySessionId: string | null;
};

function toRecord(row: RawKillSwitchRow): KillSwitchRecord {
  return {
    id: row.id,
    scope: row.scope as KillSwitchScope,
    target: row.target,
    mode: row.mode as KillSwitchMode,
    reason: row.reason,
    pausedAt: row.pausedAt,
    pausedBySessionId: row.pausedBySessionId,
    expiresAt: row.expiresAt,
    resumedAt: row.resumedAt,
    resumedBySessionId: row.resumedBySessionId,
  };
}

function assertValidInsert(input: InsertKillSwitchInput): void {
  if (!KILL_SWITCH_SCOPES.includes(input.scope)) {
    throw new Error(`kill_switch: invalid scope '${input.scope}' (allowed: ${KILL_SWITCH_SCOPES.join(', ')})`);
  }
  if (input.mode !== undefined && !KILL_SWITCH_MODES.includes(input.mode)) {
    throw new Error(`kill_switch: invalid mode '${input.mode}' (allowed: ${KILL_SWITCH_MODES.join(', ')})`);
  }
  if (input.scope === 'global') {
    if (input.target !== null && input.target !== undefined && input.target !== '') {
      throw new Error(`kill_switch: scope='global' requires target=null (got '${input.target}')`);
    }
  } else {
    if (input.target === null || input.target === undefined || input.target === '') {
      throw new Error(`kill_switch: scope='${input.scope}' requires a non-empty target`);
    }
  }
  if (input.reason.trim() === '') {
    throw new Error('kill_switch: reason must be a non-empty string (operator audit context)');
  }
}

/**
 * Hot-path query for the bridge's PreToolUse evaluator.
 *
 * Returns every active (non-resumed, non-expired) kill switch that
 * COULD match an event in the current project context. The in-memory
 * matcher `findKillSwitchMatchingEvent` then narrows to the specific
 * row that matches the event's toolName + agentType.
 *
 * SQL filter:
 *
 *   - `resumed_at IS NULL` — soft-resume invariant (spec §6 AC #11).
 *   - `expires_at IS NULL OR expires_at > now()` — auto-expiry handled
 *     in-flight without a maintenance job. The column is unindexed; the
 *     leading-column `resumed_at` filter narrows the row set to the
 *     active set first, so the expiry filter walks at most a handful
 *     of rows per query.
 *   - `scope IN ('global','tool','agent_type') OR (scope='project' AND target=projectId)`
 *     — `project`-scoped switches whose target ≠ projectId are
 *     irrelevant to this event and stay out of the result set. When
 *     `projectId` is `null` (no project context resolved), only
 *     non-`project` scopes come back.
 *
 * Order: `paused_at ASC` so the oldest active switch is first. The
 * matcher's first-match-wins semantics use this ordering.
 *
 * Returns the empty array if no active switches match the project
 * context. Throws on DB error — caller decides what to do (the
 * bridge fails open per §7).
 */
export async function listActiveKillSwitches(
  db: DbHandle,
  projectId: string | null,
  options: { now?: Date } = {},
): Promise<KillSwitchRecord[]> {
  const now = options.now ?? new Date();

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.killSwitches;
    const scopeFilter =
      projectId !== null
        ? or(inArray(t.scope, ['global', 'tool', 'agent_type']), and(eq(t.scope, 'project'), eq(t.target, projectId)))
        : inArray(t.scope, ['global', 'tool', 'agent_type']);

    const rows = await db.db
      .select()
      .from(t)
      .where(and(isNull(t.resumedAt), or(isNull(t.expiresAt), gt(t.expiresAt, now)), scopeFilter))
      .orderBy(asc(t.pausedAt));
    return rows.map((r) => toRecord(r as RawKillSwitchRow));
  }

  const t = postgresSchema.killSwitches;
  const scopeFilter =
    projectId !== null
      ? or(inArray(t.scope, ['global', 'tool', 'agent_type']), and(eq(t.scope, 'project'), eq(t.target, projectId)))
      : inArray(t.scope, ['global', 'tool', 'agent_type']);

  const rows = await db.db
    .select()
    .from(t)
    .where(and(isNull(t.resumedAt), or(isNull(t.expiresAt), gt(t.expiresAt, now)), scopeFilter))
    .orderBy(asc(t.pausedAt));
  return rows.map((r) => toRecord(r as RawKillSwitchRow));
}

/**
 * Scope-agnostic active-row read.
 *
 * `listActiveKillSwitches` filters by project-context to scope what
 * the bridge evaluator needs per event. The doctor (M08b S18 check 31)
 * and any future "show me everything paused" surface (web app, CLI
 * status) need EVERY active row regardless of scope, including
 * `scope='project'` rows for projects other than the current cwd's.
 *
 * Same active-row predicate (`resumed_at IS NULL` AND
 * `expires_at IS NULL OR > now`); no scope filter.
 */
export async function listAllActiveKillSwitches(
  db: DbHandle,
  options: { now?: Date } = {},
): Promise<KillSwitchRecord[]> {
  const now = options.now ?? new Date();

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.killSwitches;
    const rows = await db.db
      .select()
      .from(t)
      .where(and(isNull(t.resumedAt), or(isNull(t.expiresAt), gt(t.expiresAt, now))))
      .orderBy(asc(t.pausedAt));
    return rows.map((r) => toRecord(r as RawKillSwitchRow));
  }

  const t = postgresSchema.killSwitches;
  const rows = await db.db
    .select()
    .from(t)
    .where(and(isNull(t.resumedAt), or(isNull(t.expiresAt), gt(t.expiresAt, now))))
    .orderBy(asc(t.pausedAt));
  return rows.map((r) => toRecord(r as RawKillSwitchRow));
}

/**
 * CLI `coodra pause` writes a row via this helper. Validates the
 * polymorphic shape (target null iff scope='global'), generates the
 * UUID, applies the OQ-1 default mode='hard'.
 *
 * NOT idempotent by-design at the schema level — each `pause` call
 * produces a fresh row (multiple "I paused for reason X" + "I paused
 * for reason Y" rows can coexist; the matcher takes the oldest
 * unresumed row per scope+target). The CLI in S3 emits a UX-level
 * "already paused at this scope" warning before calling this if it
 * detects an existing active row at the same (scope, target).
 */
export async function insertKillSwitch(db: DbHandle, input: InsertKillSwitchInput): Promise<KillSwitchRecord> {
  assertValidInsert(input);

  const id = `ks_${randomUUID().replace(/-/g, '')}`;
  const mode = input.mode ?? 'hard';
  const target = input.scope === 'global' ? null : (input.target as string);

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.killSwitches;
    await db.db.insert(t).values({
      id,
      scope: input.scope,
      target,
      mode,
      reason: input.reason,
      pausedBySessionId: input.pausedBySessionId ?? null,
      expiresAt: input.expiresAt ?? null,
    });
    const inserted = await db.db.select().from(t).where(eq(t.id, id)).limit(1);
    const row = inserted[0];
    if (row === undefined) throw new Error(`kill_switch insert failed: row id=${id} not found after insert`);
    killSwitchLogger.info(
      { event: 'kill_switch_inserted', id, scope: input.scope, target, mode, hasExpiry: input.expiresAt != null },
      'kill switch inserted (sqlite)',
    );
    return toRecord(row as RawKillSwitchRow);
  }

  const t = postgresSchema.killSwitches;
  const inserted = await db.db
    .insert(t)
    .values({
      id,
      scope: input.scope,
      target,
      mode,
      reason: input.reason,
      pausedBySessionId: input.pausedBySessionId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new Error(`kill_switch insert failed: row id=${id} not returned after insert`);
  killSwitchLogger.info(
    { event: 'kill_switch_inserted', id, scope: input.scope, target, mode, hasExpiry: input.expiresAt != null },
    'kill switch inserted (postgres)',
  );
  return toRecord(row as RawKillSwitchRow);
}

/**
 * Resume a single kill switch by id. Returns the post-resume row on
 * success or `null` if the switch was already resumed / does not
 * exist. Idempotent: re-resuming a row already marked resumed is a
 * no-op that returns `null` (the CLI translates this to a
 * "no matching active switch" message).
 *
 * Soft-resume only: the row stays in the table with `resumed_at` set.
 */
export async function softResumeKillSwitch(
  db: DbHandle,
  args: { id: string; resumedBySessionId?: string | null; now?: Date },
): Promise<KillSwitchRecord | null> {
  const now = args.now ?? new Date();

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.killSwitches;
    // better-sqlite3 .update() returns RunResult { changes, lastInsertRowid }.
    // `changes === 0` means the WHERE matched no rows — i.e. the switch
    // is already resumed, doesn't exist, or had its row removed since the
    // last list. Treat all three the same: return null so the caller
    // exits with "no matching active switch" (CLI exit code 1).
    const updated = await db.db
      .update(t)
      .set({ resumedAt: now, resumedBySessionId: args.resumedBySessionId ?? null })
      .where(and(eq(t.id, args.id), isNull(t.resumedAt)));
    const changes = (updated as { changes?: number }).changes ?? 0;
    if (changes === 0) return null;

    // Re-select the post-update row to return the canonical shape.
    const rows = await db.db.select().from(t).where(eq(t.id, args.id)).limit(1);
    const row = rows[0];
    if (row === undefined) return null; // race window between update + select; treat as no-op.
    killSwitchLogger.info(
      {
        event: 'kill_switch_resumed',
        id: args.id,
        resumedBySessionId: args.resumedBySessionId ?? null,
      },
      'kill switch resumed (sqlite)',
    );
    return toRecord(row as RawKillSwitchRow);
  }

  const t = postgresSchema.killSwitches;
  const updated = await db.db
    .update(t)
    .set({ resumedAt: now, resumedBySessionId: args.resumedBySessionId ?? null })
    .where(and(eq(t.id, args.id), isNull(t.resumedAt)))
    .returning();
  const row = updated[0];
  if (row === undefined) return null;
  killSwitchLogger.info(
    { event: 'kill_switch_resumed', id: args.id, resumedBySessionId: args.resumedBySessionId ?? null },
    'kill switch resumed (postgres)',
  );
  return toRecord(row as RawKillSwitchRow);
}

/**
 * Resume every active kill switch matching the optional filter.
 * `--all` (no filter) resumes all active switches; `--scope X
 * --target Y` resumes every active switch matching the filter.
 *
 * Returns the post-resume rows. Empty array if nothing matched (the
 * CLI translates this to exit-1 + "no matching active switch").
 */
export async function softResumeAllKillSwitches(
  db: DbHandle,
  filter: { scope?: KillSwitchScope; target?: string | null; resumedBySessionId?: string | null; now?: Date } = {},
): Promise<KillSwitchRecord[]> {
  const now = filter.now ?? new Date();

  if (db.kind === 'sqlite') {
    const t = sqliteSchema.killSwitches;
    const conditions = [isNull(t.resumedAt)];
    if (filter.scope !== undefined) conditions.push(eq(t.scope, filter.scope));
    if (filter.target !== undefined) {
      conditions.push(filter.target === null ? isNull(t.target) : eq(t.target, filter.target));
    }

    // Pre-compute the IDs that will be updated so we can re-select them
    // after — sqlite drizzle's .update() doesn't return rows.
    const targets = await db.db
      .select({ id: t.id })
      .from(t)
      .where(and(...conditions));
    if (targets.length === 0) return [];
    const ids = targets.map((r) => r.id);

    await db.db
      .update(t)
      .set({ resumedAt: now, resumedBySessionId: filter.resumedBySessionId ?? null })
      .where(inArray(t.id, ids));

    const rows = await db.db.select().from(t).where(inArray(t.id, ids));
    killSwitchLogger.info(
      { event: 'kill_switches_bulk_resumed', count: rows.length, scope: filter.scope, target: filter.target },
      'kill switches bulk-resumed (sqlite)',
    );
    return rows.map((r) => toRecord(r as RawKillSwitchRow));
  }

  const t = postgresSchema.killSwitches;
  const conditions = [isNull(t.resumedAt)];
  if (filter.scope !== undefined) conditions.push(eq(t.scope, filter.scope));
  if (filter.target !== undefined) {
    conditions.push(filter.target === null ? isNull(t.target) : eq(t.target, filter.target));
  }

  const updated = await db.db
    .update(t)
    .set({ resumedAt: now, resumedBySessionId: filter.resumedBySessionId ?? null })
    .where(and(...conditions))
    .returning();
  killSwitchLogger.info(
    { event: 'kill_switches_bulk_resumed', count: updated.length, scope: filter.scope, target: filter.target },
    'kill switches bulk-resumed (postgres)',
  );
  return updated.map((r) => toRecord(r as RawKillSwitchRow));
}

/**
 * Pure in-memory matcher. Iterates `switches` (already filtered to
 * the active + project-relevant set by `listActiveKillSwitches`) and
 * returns the first row whose scope + target matches the event.
 *
 * First-match-wins by `paused_at ASC` (the input array's order — set
 * by `listActiveKillSwitches`'s ORDER BY). Operators with multiple
 * active switches at different scopes get the oldest. Documented as
 * v1 semantics in `docs/feature-packs/08b-cli-expansion/spec.md` §11
 * OQ-1's analysis; precedence rules (e.g., most-specific scope
 * wins, hard-mode wins over soft) can layer on in a future pass.
 *
 * Returns `null` when no switch matches — the bridge falls through
 * to the policy evaluator.
 */
export function findKillSwitchMatchingEvent(
  switches: readonly KillSwitchRecord[],
  event: { projectId?: string; toolName: string; agentType: string },
): KillSwitchRecord | null {
  for (const s of switches) {
    if (s.scope === 'global') return s;
    if (s.scope === 'project' && event.projectId !== undefined && s.target === event.projectId) return s;
    if (s.scope === 'tool' && s.target === event.toolName) return s;
    if (s.scope === 'agent_type' && s.target === event.agentType) return s;
  }
  return null;
}
