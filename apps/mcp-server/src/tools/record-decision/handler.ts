import { createHash, randomUUID } from 'node:crypto';

import { type DbHandle, postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
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

interface RunAttribution {
  readonly projectId: string;
  readonly orgId: string | null;
  readonly workPackId: string | null;
}

async function selectRunAttribution(db: DbHandle, runId: string): Promise<RunAttribution | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        projectId: sqliteSchema.runs.projectId,
        runOrgId: sqliteSchema.runs.orgId,
        projectOrgId: sqliteSchema.projects.orgId,
        workPackId: sqliteSchema.runs.workPackId,
      })
      .from(sqliteSchema.runs)
      .innerJoin(sqliteSchema.projects, eq(sqliteSchema.projects.id, sqliteSchema.runs.projectId))
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    const row = rows[0];
    return row
      ? { projectId: row.projectId, orgId: row.runOrgId ?? row.projectOrgId, workPackId: row.workPackId }
      : null;
  }
  const rows = await db.db
    .select({
      projectId: postgresSchema.runs.projectId,
      runOrgId: postgresSchema.runs.orgId,
      projectOrgId: postgresSchema.projects.orgId,
      workPackId: postgresSchema.runs.workPackId,
    })
    .from(postgresSchema.runs)
    .innerJoin(postgresSchema.projects, eq(postgresSchema.projects.id, postgresSchema.runs.projectId))
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  const row = rows[0];
  return row ? { projectId: row.projectId, orgId: row.runOrgId ?? row.projectOrgId, workPackId: row.workPackId } : null;
}

async function selectWorkPackIdBySlug(db: DbHandle, projectId: string, slug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.workPacks.id })
      .from(sqliteSchema.workPacks)
      .where(and(eq(sqliteSchema.workPacks.projectId, projectId), eq(sqliteSchema.workPacks.slug, slug)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.workPacks.id })
    .from(postgresSchema.workPacks)
    .where(and(eq(postgresSchema.workPacks.projectId, projectId), eq(postgresSchema.workPacks.slug, slug)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Links a decision to one or more Work Packs via the many-to-many
 * `work_pack_decision_links` table (coodra-work redesign, round 2).
 * Idempotent per (workPackId, decisionId) pair — safe to call again on
 * an idempotent-hit decision re-record, e.g. to add a new pack link to
 * an already-recorded decision.
 */
async function linkDecisionToWorkPacks(
  db: DbHandle,
  args: { readonly orgId: string | null; readonly projectId: string; readonly decisionId: string },
  workPackIds: ReadonlySet<string>,
): Promise<void> {
  for (const workPackId of workPackIds) {
    if (db.kind === 'sqlite') {
      await db.db
        .insert(sqliteSchema.workPackDecisionLinks)
        .values({
          id: `wpdl_${randomUUID()}`,
          orgId: args.orgId,
          projectId: args.projectId,
          workPackId,
          decisionId: args.decisionId,
        })
        .onConflictDoNothing({
          target: [sqliteSchema.workPackDecisionLinks.workPackId, sqliteSchema.workPackDecisionLinks.decisionId],
        });
      continue;
    }
    await db.db
      .insert(postgresSchema.workPackDecisionLinks)
      .values({
        id: `wpdl_${randomUUID()}`,
        orgId: args.orgId,
        projectId: args.projectId,
        workPackId,
        decisionId: args.decisionId,
      })
      .onConflictDoNothing({
        target: [postgresSchema.workPackDecisionLinks.workPackId, postgresSchema.workPackDecisionLinks.decisionId],
      });
  }
}

/**
 * Append-only redesign (2026-08-05) — mechanically bumps
 * `work_packs.last_activity_at` for every Work Pack a decision links
 * to, in the same call, never a background job. A decision is activity
 * on that Work Pack just as much as a context-pack save; mirrors
 * `context-pack.ts`'s `touchWorkPackActivity` but doesn't touch
 * `latest_context_pack_id` — that column is context-pack-specific.
 */
async function touchWorkPacksActivity(db: DbHandle, workPackIds: ReadonlySet<string>, now: Date): Promise<void> {
  for (const workPackId of workPackIds) {
    if (db.kind === 'sqlite') {
      await db.db
        .update(sqliteSchema.workPacks)
        .set({ lastActivityAt: now })
        .where(eq(sqliteSchema.workPacks.id, workPackId));
      continue;
    }
    await db.db
      .update(postgresSchema.workPacks)
      .set({ lastActivityAt: now })
      .where(eq(postgresSchema.workPacks.id, workPackId));
  }
}

interface ExistingDecisionRow {
  readonly id: string;
  readonly createdAt: Date;
}

interface DecisionTargetRow {
  readonly id: string;
  readonly projectId: string | null;
  readonly description: string;
  readonly rationale: string;
  readonly context: string | null;
  readonly impact: string | null;
}

interface EdgeInsert {
  readonly projectId: string;
  readonly fromDecisionId: string;
  readonly edgeType: 'supersedes' | 'affects';
  readonly targetType: 'decision' | 'file' | 'work_pack' | 'graph_node';
  readonly targetId: string;
  readonly metadataJson: string | null;
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

async function selectDecisionTargets(db: DbHandle, ids: ReadonlyArray<string>): Promise<Map<string, DecisionTargetRow>> {
  const uniqueIds = [...new Set(ids)].filter((id) => id.length > 0);
  const byId = new Map<string, DecisionTargetRow>();
  if (uniqueIds.length === 0) return byId;
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.decisions.id,
        projectId: sqliteSchema.decisions.projectId,
        description: sqliteSchema.decisions.description,
        rationale: sqliteSchema.decisions.rationale,
        context: sqliteSchema.decisions.context,
        impact: sqliteSchema.decisions.impact,
      })
      .from(sqliteSchema.decisions)
      .where(inArray(sqliteSchema.decisions.id, uniqueIds));
    for (const row of rows) byId.set(row.id, row);
    return byId;
  }
  const rows = await db.db
    .select({
      id: postgresSchema.decisions.id,
      projectId: postgresSchema.decisions.projectId,
      description: postgresSchema.decisions.description,
      rationale: postgresSchema.decisions.rationale,
      context: postgresSchema.decisions.context,
      impact: postgresSchema.decisions.impact,
    })
    .from(postgresSchema.decisions)
    .where(inArray(postgresSchema.decisions.id, uniqueIds));
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

async function selectSupersededTargets(db: DbHandle, decisionId: string): Promise<string[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ targetId: sqliteSchema.decisionEdges.targetId })
      .from(sqliteSchema.decisionEdges)
      .where(
        and(
          eq(sqliteSchema.decisionEdges.fromDecisionId, decisionId),
          eq(sqliteSchema.decisionEdges.edgeType, 'supersedes'),
          eq(sqliteSchema.decisionEdges.targetType, 'decision'),
        ),
      );
    return rows.map((row) => row.targetId);
  }
  const rows = await db.db
    .select({ targetId: postgresSchema.decisionEdges.targetId })
    .from(postgresSchema.decisionEdges)
    .where(
      and(
        eq(postgresSchema.decisionEdges.fromDecisionId, decisionId),
        eq(postgresSchema.decisionEdges.edgeType, 'supersedes'),
        eq(postgresSchema.decisionEdges.targetType, 'decision'),
      ),
    );
  return rows.map((row) => row.targetId);
}

async function selectIncomingSupersededTargetIds(db: DbHandle, decisionIds: ReadonlyArray<string>): Promise<Set<string>> {
  const uniqueIds = [...new Set(decisionIds)];
  const superseded = new Set<string>();
  if (uniqueIds.length === 0) return superseded;
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ targetId: sqliteSchema.decisionEdges.targetId })
      .from(sqliteSchema.decisionEdges)
      .where(
        and(
          eq(sqliteSchema.decisionEdges.edgeType, 'supersedes'),
          eq(sqliteSchema.decisionEdges.targetType, 'decision'),
          inArray(sqliteSchema.decisionEdges.targetId, uniqueIds),
        ),
      );
    for (const row of rows) superseded.add(row.targetId);
    return superseded;
  }
  const rows = await db.db
    .select({ targetId: postgresSchema.decisionEdges.targetId })
    .from(postgresSchema.decisionEdges)
    .where(
      and(
        eq(postgresSchema.decisionEdges.edgeType, 'supersedes'),
        eq(postgresSchema.decisionEdges.targetType, 'decision'),
        inArray(postgresSchema.decisionEdges.targetId, uniqueIds),
      ),
    );
  for (const row of rows) superseded.add(row.targetId);
  return superseded;
}

async function wouldCreateSupersessionCycle(
  db: DbHandle,
  fromDecisionId: string,
  targetDecisionId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  const stack = [targetDecisionId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === fromDecisionId) return true;
    seen.add(current);
    stack.push(...(await selectSupersededTargets(db, current)));
  }
  return false;
}

async function insertDecisionEdges(db: DbHandle, edges: ReadonlyArray<EdgeInsert>): Promise<void> {
  const unique = new Map<string, EdgeInsert>();
  for (const edge of edges) {
    unique.set(`${edge.fromDecisionId}\0${edge.edgeType}\0${edge.targetType}\0${edge.targetId}`, edge);
  }
  for (const edge of unique.values()) {
    if (db.kind === 'sqlite') {
      await db.db
        .insert(sqliteSchema.decisionEdges)
        .values({
          id: `de_${randomUUID()}`,
          projectId: edge.projectId,
          fromDecisionId: edge.fromDecisionId,
          edgeType: edge.edgeType,
          targetType: edge.targetType,
          targetId: edge.targetId,
          metadataJson: edge.metadataJson,
        })
        .onConflictDoNothing({
          target: [
            sqliteSchema.decisionEdges.fromDecisionId,
            sqliteSchema.decisionEdges.edgeType,
            sqliteSchema.decisionEdges.targetType,
            sqliteSchema.decisionEdges.targetId,
          ],
        });
      continue;
    }
    await db.db
      .insert(postgresSchema.decisionEdges)
      .values({
        id: `de_${randomUUID()}`,
        projectId: edge.projectId,
        fromDecisionId: edge.fromDecisionId,
        edgeType: edge.edgeType,
        targetType: edge.targetType,
        targetId: edge.targetId,
        metadataJson: edge.metadataJson,
      })
      .onConflictDoNothing({
        target: [
          postgresSchema.decisionEdges.fromDecisionId,
          postgresSchema.decisionEdges.edgeType,
          postgresSchema.decisionEdges.targetType,
          postgresSchema.decisionEdges.targetId,
        ],
      });
  }
}

function parseImpact(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function textTokens(...parts: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    for (const token of part.toLowerCase().match(/[a-z0-9_/-]{4,}/g) ?? []) {
      tokens.add(token);
      if (tokens.size >= 24) return tokens;
    }
  }
  return tokens;
}

async function selectRecentActiveDecisionCandidates(
  db: DbHandle,
  projectId: string,
  currentDecisionId: string,
): Promise<DecisionTargetRow[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        id: sqliteSchema.decisions.id,
        projectId: sqliteSchema.decisions.projectId,
        description: sqliteSchema.decisions.description,
        rationale: sqliteSchema.decisions.rationale,
        context: sqliteSchema.decisions.context,
        impact: sqliteSchema.decisions.impact,
      })
      .from(sqliteSchema.decisions)
      .where(eq(sqliteSchema.decisions.projectId, projectId))
      .orderBy(desc(sqliteSchema.decisions.createdAt))
      .limit(100);
    const superseded = await selectIncomingSupersededTargetIds(
      db,
      rows.map((row) => row.id),
    );
    return rows.filter((row) => row.id !== currentDecisionId && !superseded.has(row.id));
  }
  const rows = await db.db
    .select({
      id: postgresSchema.decisions.id,
      projectId: postgresSchema.decisions.projectId,
      description: postgresSchema.decisions.description,
      rationale: postgresSchema.decisions.rationale,
      context: postgresSchema.decisions.context,
      impact: postgresSchema.decisions.impact,
    })
    .from(postgresSchema.decisions)
    .where(eq(postgresSchema.decisions.projectId, projectId))
    .orderBy(desc(postgresSchema.decisions.createdAt))
    .limit(100);
  const superseded = await selectIncomingSupersededTargetIds(
    db,
    rows.map((row) => row.id),
  );
  return rows.filter((row) => row.id !== currentDecisionId && !superseded.has(row.id));
}

async function relatedDecisionCandidates(
  db: DbHandle,
  args: {
    readonly projectId: string;
    readonly decisionId: string;
    readonly description: string;
    readonly rationale: string;
    readonly context: string | null;
    readonly impact: ReadonlyArray<string>;
  },
): Promise<Array<{ readonly decisionId: string; readonly description: string; readonly reason: string }>> {
  const tokens = textTokens(args.description, args.rationale, args.context, args.impact.join(' '));
  if (tokens.size === 0) return [];
  const candidates = await selectRecentActiveDecisionCandidates(db, args.projectId, args.decisionId);
  const scored: Array<{ row: DecisionTargetRow; score: number; matched: string[] }> = [];
  for (const row of candidates) {
    const rowTokens = textTokens(row.description, row.rationale, row.context, parseImpact(row.impact).join(' '));
    const matched = [...tokens].filter((token) => rowTokens.has(token));
    if (matched.length > 0) scored.push({ row, score: matched.length, matched: matched.slice(0, 3) });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ row, matched }) => ({
      decisionId: row.id,
      description: row.description,
      reason: `overlap:${matched.join(',')}`,
    }));
}

function impactTarget(raw: string): { targetType: 'file' | 'work_pack' | 'graph_node'; targetId: string } | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.startsWith('graph_node:')) {
    const targetId = value.slice('graph_node:'.length).trim();
    return targetId.length > 0 ? { targetType: 'graph_node', targetId } : null;
  }
  if (value.startsWith('work_pack:')) {
    const targetId = value.slice('work_pack:'.length).trim();
    return targetId.length > 0 ? { targetType: 'work_pack', targetId } : null;
  }
  return { targetType: 'file', targetId: value };
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
    readonly orgId: string | null;
    readonly projectId: string;
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
        orgId: row.orgId,
        projectId: row.projectId,
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
      orgId: row.orgId,
      projectId: row.projectId,
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
    const runAttribution = await selectRunAttribution(deps.db, input.runId);
    if (runAttribution === null) {
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
    const existingDecisionBeforeInsert = await selectByIdempotencyKey(deps.db, idempotencyKey);
    const candidateDecisionId = existingDecisionBeforeInsert?.id ?? `dec_${randomUUID()}`;
    if (input.supersedesDecisionIds !== undefined && input.supersedesDecisionIds.length > 0) {
      const targetRows = await selectDecisionTargets(deps.db, input.supersedesDecisionIds);
      for (const targetDecisionId of new Set(input.supersedesDecisionIds)) {
        const target = targetRows.get(targetDecisionId);
        if (target === undefined || target.projectId !== runAttribution.projectId) {
          return {
            ok: false,
            error: 'supersedes_decision_not_found',
            decisionId: targetDecisionId,
            howToFix:
              'Only pass supersedesDecisionIds that exist in this project. Query decisions first, then retry with the exact decision id.',
          };
        }
        if (
          targetDecisionId === candidateDecisionId ||
          (await wouldCreateSupersessionCycle(deps.db, candidateDecisionId, targetDecisionId))
        ) {
          return {
            ok: false,
            error: 'supersession_cycle',
            decisionId: targetDecisionId,
            howToFix:
              'This supersession edge would create a cycle. Leave the older edge intact or record a new non-cyclic replacement decision.',
          };
        }
      }
    }

    const { inserted, id, createdAt } = await insertIgnoreOnConflict(deps.db, {
      id: candidateDecisionId,
      orgId: actor?.orgId ?? runAttribution.orgId,
      projectId: runAttribution.projectId,
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

    // coodra-work redesign, round 2 — always link to the run's current
    // Work Pack (if any), plus any explicitly-named related packs. Runs
    // even on an idempotent hit so a later call can add a new pack link
    // to an already-recorded decision; safe no-op via ON CONFLICT.
    const workPackIdsToLink = new Set<string>();
    if (runAttribution.workPackId !== null) workPackIdsToLink.add(runAttribution.workPackId);
    if (input.workPackSlugs !== undefined) {
      for (const slug of input.workPackSlugs) {
        const resolved = await selectWorkPackIdBySlug(deps.db, runAttribution.projectId, slug);
        if (resolved !== null) {
          workPackIdsToLink.add(resolved);
        } else {
          handlerLogger.info(
            { event: 'record_decision_work_pack_slug_not_found', runId: input.runId, slug, sessionId: ctx.sessionId },
            'record_decision: workPackSlugs entry did not resolve to a Work Pack; skipping that link',
          );
        }
      }
    }
    if (workPackIdsToLink.size > 0) {
      await linkDecisionToWorkPacks(
        deps.db,
        { orgId: actor?.orgId ?? runAttribution.orgId, projectId: runAttribution.projectId, decisionId: id },
        workPackIdsToLink,
      );
      await touchWorkPacksActivity(deps.db, workPackIdsToLink, ctx.now());
    }

    const edgeInserts: EdgeInsert[] = [];
    if (input.supersedesDecisionIds !== undefined && input.supersedesDecisionIds.length > 0) {
      for (const targetDecisionId of new Set(input.supersedesDecisionIds)) {
        edgeInserts.push({
          projectId: runAttribution.projectId,
          fromDecisionId: id,
          edgeType: 'supersedes',
          targetType: 'decision',
          targetId: targetDecisionId,
          metadataJson: JSON.stringify({ source: 'record_decision.supersedesDecisionIds' }),
        });
      }
    }

    if (input.impact !== undefined) {
      for (const rawImpact of input.impact) {
        const target = impactTarget(rawImpact);
        if (target === null) continue;
        edgeInserts.push({
          projectId: runAttribution.projectId,
          fromDecisionId: id,
          edgeType: 'affects',
          targetType: target.targetType,
          targetId: target.targetId,
          metadataJson: JSON.stringify({ source: 'record_decision.impact', raw: rawImpact }),
        });
      }
    }
    for (const workPackId of workPackIdsToLink) {
      edgeInserts.push({
        projectId: runAttribution.projectId,
        fromDecisionId: id,
        edgeType: 'affects',
        targetType: 'work_pack',
        targetId: workPackId,
        metadataJson: JSON.stringify({ source: 'record_decision.workPackLink' }),
      });
    }
    if (edgeInserts.length > 0) {
      await insertDecisionEdges(deps.db, edgeInserts);
    }

    const candidates = inserted
      ? await relatedDecisionCandidates(deps.db, {
          projectId: runAttribution.projectId,
          decisionId: id,
          description: input.description,
          rationale: input.rationale,
          context: input.context ?? null,
          impact: input.impact ?? [],
        })
      : [];

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
      relatedDecisionCandidates: candidates,
    };
  };
}
