import { createHash, randomUUID } from 'node:crypto';

import { type DbHandle, postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { requireActorIdentityForTeamMode } from '../../lib/actor-identity.js';
import type { RecordDecisionInput, RecordDecisionOutput } from './schema.js';

/**
 * Handler factory for `coodra__record_decision` (§24.4, S13).
 *
 * Factory shape (not bare static) because the handler closes over a
 * `DbHandle` for the `runs` SELECT + `decisions` INSERT. No route
 * through `ctx.runRecorder` — decisions are a first-class append-only
 * table in their own right (see S13 pre-flight note in
 * docs/feature-packs/02-mcp-server/implementation.md, and the new
 * migration 0003_*.sql which creates the `decisions` table on both
 * dialects).
 *
 * Flow:
 *   1. SELECT runs.id for `input.runId`. Missing → structured
 *      `{ ok: false, error: 'run_not_found', howToFix }` soft-failure
 *      per §9.1.2 canonical shape.
 *   2. Compute idempotency key:
 *        `dec:{runId}:{sha256(description).slice(0,32)}`
 *      Same runId + identical description bodies collide on the
 *      `decisions.idempotency_key` UNIQUE index — the retry returns
 *      the existing row's id with `created: false`.
 *   3. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING. On insert
 *      we generated the id upfront and return `created: true`. On
 *      conflict we SELECT the existing row and return `created: false`.
 *   4. `alternatives` is stored as a JSON-encoded string on both
 *      dialects (dialect parity; the handler owns the (de)serialisation
 *      — Postgres gains nothing from JSONB here since no one queries
 *      into the alternatives array).
 *
 * No policy-decision audit write — S14 (`check_policy`) remains the
 * first caller of `recordPolicyDecision`.
 *
 * No write via `ctx.runRecorder`. This is intentional: decisions are
 * permanent records with their own idempotency contract, whereas
 * `run_events` is a tool-invocation trace. The two don't share
 * lifecycle rules (decisions outlive their runs via
 * `ON DELETE SET NULL`; run_events follow the same pattern for trace
 * preservation).
 */

const handlerLogger = createLogger('mcp-server.tool.record_decision');

export interface RecordDecisionHandlerDeps {
  readonly db: DbHandle;
}

function computeIdempotencyKey(runId: string, description: string): string {
  const hash = createHash('sha256').update(description).digest('hex').slice(0, 32);
  return `dec:${runId}:${hash}`;
}

async function runExists(db: DbHandle, runId: string): Promise<boolean> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.runs.id })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows.length > 0;
  }
  const rows = await db.db
    .select({ id: postgresSchema.runs.id })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows.length > 0;
}

interface ExistingDecisionRow {
  readonly id: string;
  readonly createdAt: Date;
}

async function selectByIdempotencyKey(db: DbHandle, key: string): Promise<ExistingDecisionRow | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.decisions.id, createdAt: sqliteSchema.decisions.createdAt })
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    return row ? { id: row.id, createdAt: row.createdAt } : null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.decisions.id, createdAt: postgresSchema.decisions.createdAt })
    .from(postgresSchema.decisions)
    .where(eq(postgresSchema.decisions.idempotencyKey, key))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, createdAt: row.createdAt } : null;
}

interface InsertResult {
  readonly inserted: boolean;
  readonly id: string;
  readonly createdAt: Date;
}

async function insertIgnoreOnConflict(
  db: DbHandle,
  row: {
    readonly id: string;
    readonly idempotencyKey: string;
    readonly runId: string;
    readonly description: string;
    readonly rationale: string;
    readonly alternatives: string | null;
    // M05 fields — all nullable, so legacy callers without these
    // continue to work and old rows display gracefully.
    readonly context: string | null;
    readonly impact: string | null;
    readonly confidence: 'high' | 'medium' | 'low' | null;
    readonly reversible: boolean | null;
    // Module 04 Phase 4 — Clerk user id of the actor whose agent
    // recorded this decision. NULL on solo + when team config absent.
    readonly createdByUserId: string | null;
  },
): Promise<InsertResult> {
  if (db.kind === 'sqlite') {
    const inserted = await db.db
      .insert(sqliteSchema.decisions)
      .values({
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
        createdByUserId: row.createdByUserId,
      })
      .onConflictDoNothing({ target: sqliteSchema.decisions.idempotencyKey })
      .returning({
        id: sqliteSchema.decisions.id,
        createdAt: sqliteSchema.decisions.createdAt,
      });
    const fresh = inserted[0];
    if (fresh) return { inserted: true, id: fresh.id, createdAt: fresh.createdAt };
    const existing = await selectByIdempotencyKey(db, row.idempotencyKey);
    if (!existing) throw new Error('record_decision: row vanished between insert conflict and select');
    return { inserted: false, id: existing.id, createdAt: existing.createdAt };
  }
  const inserted = await db.db
    .insert(postgresSchema.decisions)
    .values({
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
      createdByUserId: row.createdByUserId,
    })
    .onConflictDoNothing({ target: postgresSchema.decisions.idempotencyKey })
    .returning({
      id: postgresSchema.decisions.id,
      createdAt: postgresSchema.decisions.createdAt,
    });
  const fresh = inserted[0];
  if (fresh) return { inserted: true, id: fresh.id, createdAt: fresh.createdAt };
  const existing = await selectByIdempotencyKey(db, row.idempotencyKey);
  if (!existing) throw new Error('record_decision: row vanished between insert conflict and select');
  return { inserted: false, id: existing.id, createdAt: existing.createdAt };
}

export function createRecordDecisionHandler(deps: RecordDecisionHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createRecordDecisionHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createRecordDecisionHandler: deps.db must be a DbHandle');
  }

  return async function recordDecisionHandler(
    input: RecordDecisionInput,
    ctx: ToolContext,
  ): Promise<RecordDecisionOutput> {
    if (!(await runExists(deps.db, input.runId))) {
      handlerLogger.info(
        { event: 'record_decision_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'record_decision: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to create a run for this session, then retry record_decision with the returned runId.',
      };
    }

    const idempotencyKey = computeIdempotencyKey(input.runId, input.description);
    const alternativesJson =
      input.alternatives !== undefined && input.alternatives.length > 0 ? JSON.stringify(input.alternatives) : null;
    // M05 — additive metadata. JSON-encoded array for impact (parity
    // with alternatives convention). Confidence stored as text per
    // schema enum; reversible stored as boolean (NULL when omitted).
    const impactJson = input.impact !== undefined && input.impact.length > 0 ? JSON.stringify(input.impact) : null;

    // Phase G slice G.6 — require Clerk-verified identity for team-
    // mode writes. Solo mode short-circuits to actor=null (NULL stamp).
    // Team mode + no verified token returns auth_required soft-failure
    // so the agent can surface the remediation message to the user.
    const auth = await requireActorIdentityForTeamMode();
    if (auth.kind === 'auth_required') {
      handlerLogger.info(
        { event: 'record_decision_auth_required', runId: input.runId, sessionId: ctx.sessionId },
        'record_decision: team mode but no verified Clerk JWT — returning auth_required soft-failure',
      );
      return {
        ok: false,
        error: 'auth_required',
        howToFix: auth.howToFix,
      };
    }
    const actor = auth.actor;
    const { inserted, id, createdAt } = await insertIgnoreOnConflict(deps.db, {
      id: `dec_${randomUUID()}`,
      idempotencyKey,
      runId: input.runId,
      description: input.description,
      rationale: input.rationale,
      alternatives: alternativesJson,
      context: input.context ?? null,
      impact: impactJson,
      confidence: input.confidence ?? null,
      reversible: input.reversible ?? null,
      createdByUserId: actor !== null ? actor.userId : null,
    });

    if (!inserted) {
      handlerLogger.info(
        {
          event: 'record_decision_idempotent_hit',
          runId: input.runId,
          decisionId: id,
          sessionId: ctx.sessionId,
        },
        'record_decision: idempotency key collided — returning existing decisionId',
      );
    }

    // M04 Phase 4: in team mode, enqueue a sync_to_cloud job so the
    // sync-daemon pushes the decision to cloud Postgres. Without this
    // enqueue the row lives only in local SQLite and teammates never
    // see it via the team-rows-puller. Solo mode (or when the row was
    // an idempotent hit) skips the enqueue — append-only semantics
    // mean re-pushing on conflict is harmless but wasteful.
    if (inserted && process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(deps.db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'decisions', lookup: { kind: 'idempotency_key', value: idempotencyKey } },
        });
      } catch (err) {
        handlerLogger.warn(
          {
            event: 'record_decision_sync_enqueue_failed',
            decisionId: id,
            err: err instanceof Error ? err.message : String(err),
          },
          'sync_to_cloud enqueue threw after decision insert — row will not reach cloud until next manual push',
        );
      }
    }

    return {
      ok: true,
      decisionId: id,
      createdAt: createdAt.toISOString(),
      created: inserted,
    };
  };
}
