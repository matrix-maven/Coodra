import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { toSqliteFtsQuery } from '../../lib/fts-query.js';
import type { DecisionEntry, QueryDecisionsInput, QueryDecisionsOutput } from './schema.js';

/**
 * Handler factory for `coodra__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + the decisions SELECT joined to runs.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects.id`. Missing →
 *      `{ ok: false, error: 'project_not_found', howToFix }` per §9.1.2.
 *   2. If `query` is set (BM25 full-text search, 2026-08-03): resolve
 *      matching decision ids + rank via `decisions_fts`/`search_vector`
 *      first (see `selectDecisionIdsByQuery`), then SELECT decisions.*
 *      JOIN runs constrained to those ids and the other filters, and
 *      reorder by rank in application code (id-resolution-then-inArray
 *      pattern — matches `selectDecisionIdsLinkedToWorkPacks` below).
 *      Otherwise: SELECT decisions.* JOIN runs ON decisions.run_id = runs.id
 *      WHERE runs.project_id = ?
 *        [AND decisions.run_id = ?]
 *        [AND runs.issue_ref = ?]
 *        [AND (runs.work_pack_id IN (...) OR decisions.id IN (...))]
 *      ORDER BY decisions.created_at DESC
 *      LIMIT ?
 *   3. Map rows: parse `alternatives` (JSON string[] or null → []);
 *      Date → ISO string; pass everything else through.
 *
 * Read-only: no RunRecorder emit, no policy_decisions write. No
 * auto-create on project-miss (symmetric with query_run_history).
 *
 * The JOIN against `runs` filters out orphan decisions (decisions
 * whose run was deleted, leaving run_id NULL — see decisions schema
 * docblock). Those rows survive in the DB for permanent history but
 * are unreachable from a project-scoped query, by design.
 */

const handlerLogger = createLogger('mcp-server.tool.query_decisions');

export interface QueryDecisionsHandlerDeps {
  readonly db: DbHandle;
}

async function resolveProjectId(db: DbHandle, projectSlug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * One hop of `work_pack_relationships` from `workPackId` — returns the
 * ids of packs it relates to (either direction). Used by `includeRelated`
 * to pull decisions from a related pack too, e.g. Pack 2 (currently being
 * worked) automatically seeing a decision made on related Pack 1.
 */
async function selectRelatedWorkPackIds(db: DbHandle, workPackId: string): Promise<string[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({
        source: sqliteSchema.workPackRelationships.sourceWorkPackId,
        target: sqliteSchema.workPackRelationships.targetWorkPackId,
      })
      .from(sqliteSchema.workPackRelationships)
      .where(
        or(
          eq(sqliteSchema.workPackRelationships.sourceWorkPackId, workPackId),
          eq(sqliteSchema.workPackRelationships.targetWorkPackId, workPackId),
        ),
      );
    return collectRelatedIds(rows, workPackId);
  }
  const rows = await db.db
    .select({
      source: postgresSchema.workPackRelationships.sourceWorkPackId,
      target: postgresSchema.workPackRelationships.targetWorkPackId,
    })
    .from(postgresSchema.workPackRelationships)
    .where(
      or(
        eq(postgresSchema.workPackRelationships.sourceWorkPackId, workPackId),
        eq(postgresSchema.workPackRelationships.targetWorkPackId, workPackId),
      ),
    );
  return collectRelatedIds(rows, workPackId);
}

function collectRelatedIds(
  rows: ReadonlyArray<{ readonly source: string | null; readonly target: string | null }>,
  workPackId: string,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.source === workPackId && row.target !== null) ids.add(row.target);
    if (row.target === workPackId && row.source !== null) ids.add(row.source);
  }
  return [...ids];
}

/**
 * Decision ids explicitly tagged to any of `workPackIds` via the
 * many-to-many `work_pack_decision_links` table (set by
 * `record_decision`'s `workPackSlugs`). This is the direct, write-time
 * link — independent of, and a superset alongside, the transitive
 * `runs.work_pack_id` match `selectDecisions` also applies.
 */
async function selectDecisionIdsLinkedToWorkPacks(db: DbHandle, workPackIds: ReadonlyArray<string>): Promise<string[]> {
  if (workPackIds.length === 0) return [];
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ decisionId: sqliteSchema.workPackDecisionLinks.decisionId })
      .from(sqliteSchema.workPackDecisionLinks)
      .where(inArray(sqliteSchema.workPackDecisionLinks.workPackId, workPackIds));
    return rows.map((r) => r.decisionId);
  }
  const rows = await db.db
    .select({ decisionId: postgresSchema.workPackDecisionLinks.decisionId })
    .from(postgresSchema.workPackDecisionLinks)
    .where(inArray(postgresSchema.workPackDecisionLinks.workPackId, workPackIds));
  return rows.map((r) => r.decisionId);
}

interface RawRow {
  readonly id: string;
  readonly runId: string;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly createdAt: Date;
}

interface RankedId {
  readonly id: string;
  readonly rank: number;
}

// Ceiling on how many rank-ordered candidate ids to pull out of the FTS
// structure before the other filters (runId, issueRef, workPackIds) are
// applied. Generous relative to `limit` (max 200, see schema.ts) so those
// filters never starve a query of otherwise-relevant matches.
const FTS_CANDIDATE_CAP = 500 as const;

/**
 * Resolves decision ids matching `query`, ranked best-first, via
 * `decisions_fts`/`decisions.search_vector` — see `packages/db/drizzle/
 * {sqlite,postgres}/00{24,26}_fts_search.sql`. Rank is normalized so
 * higher is always more relevant (SQLite's bm25() is natively
 * negative-lower-is-better; negated here to match Postgres's ts_rank()).
 * Neither FTS structure is in the Drizzle TS schema, so this goes
 * through raw `sql` — the resulting ids feed `inArray(...)` in
 * `selectDecisions`, the same pattern `selectDecisionIdsLinkedToWorkPacks`
 * already uses for `work_pack_decision_links`.
 */
async function selectDecisionIdsByQuery(db: DbHandle, projectId: string, query: string): Promise<RankedId[]> {
  if (db.kind === 'sqlite') {
    const ftsQuery = toSqliteFtsQuery(query);
    const rows = db.db.all<{ id: string; rank: number }>(sql`
      SELECT d.id AS id, bm25(decisions_fts) AS rank
      FROM decisions_fts
      JOIN decisions d ON d.id = decisions_fts.decision_id
      JOIN runs r ON r.id = d.run_id
      WHERE decisions_fts MATCH ${ftsQuery} AND r.project_id = ${projectId}
      ORDER BY rank
      LIMIT ${FTS_CANDIDATE_CAP}
    `);
    return rows.map((row) => ({ id: row.id, rank: -row.rank }));
  }
  const rows = (await db.db.execute(sql`
    SELECT d.id AS id, ts_rank(d.search_vector, plainto_tsquery('english', ${query})) AS rank
    FROM decisions d
    JOIN runs r ON r.id = d.run_id
    WHERE r.project_id = ${projectId}
      AND d.search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${FTS_CANDIDATE_CAP}
  `)) as unknown as { id: string; rank: number }[];
  return rows.map((row) => ({ id: row.id, rank: row.rank }));
}

async function selectDecisions(
  db: DbHandle,
  projectId: string,
  runId: string | undefined,
  issueRef: string | undefined,
  workPackIds: ReadonlyArray<string> | undefined,
  linkedDecisionIds: ReadonlyArray<string> | undefined,
  query: string | undefined,
  activeOnly: boolean,
  limit: number,
): Promise<RawRow[]> {
  let rankedIds: RankedId[] | undefined;
  if (query !== undefined) {
    rankedIds = await selectDecisionIdsByQuery(db, projectId, query);
    if (rankedIds.length === 0) return [];
  }

  if (db.kind === 'sqlite') {
    const decisions = sqliteSchema.decisions;
    const runs = sqliteSchema.runs;
    const conditions: SQL[] = [eq(runs.projectId, projectId)];
    if (runId !== undefined) conditions.push(eq(decisions.runId, runId));
    // Module 09 J2 (ADR-016) — "what was decided for PROJ-412?": filter to
    // decisions whose run is bound to this tracker issue (runs.issue_ref).
    if (issueRef !== undefined) conditions.push(eq(runs.issueRef, issueRef));
    // coodra-work redesign — matches either the transitive runs.work_pack_id
    // link (spans every run tied to a Work Pack, not just one) OR the
    // direct work_pack_decision_links tag (round 2) — see schema.ts docblock.
    if (workPackIds !== undefined && workPackIds.length > 0) {
      const workPackConditions = [inArray(runs.workPackId, workPackIds)];
      if (linkedDecisionIds !== undefined && linkedDecisionIds.length > 0) {
        workPackConditions.push(inArray(decisions.id, linkedDecisionIds));
      }
      const combined = workPackConditions.length === 1 ? workPackConditions[0] : or(...workPackConditions);
      if (combined !== undefined) conditions.push(combined);
    }
    if (rankedIds !== undefined)
      conditions.push(
        inArray(
          decisions.id,
          rankedIds.map((r) => r.id),
        ),
      );
    if (activeOnly) {
      conditions.push(sql`
        NOT EXISTS (
          SELECT 1 FROM decision_edges de
          WHERE de.edge_type = 'supersedes'
            AND de.target_type = 'decision'
            AND de.target_id = ${decisions.id}
        )
      `);
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    let selectQuery = db.db
      .select({
        id: decisions.id,
        runId: decisions.runId,
        description: decisions.description,
        rationale: decisions.rationale,
        alternatives: decisions.alternatives,
        createdAt: decisions.createdAt,
      })
      .from(decisions)
      .innerJoin(runs, eq(decisions.runId, runs.id))
      .where(where)
      .$dynamic();
    if (rankedIds === undefined) selectQuery = selectQuery.orderBy(desc(decisions.createdAt)).limit(limit);
    const rows = (await selectQuery) as RawRow[];
    return rankedIds !== undefined ? sortByRank(rows, rankedIds).slice(0, limit) : rows;
  }
  const decisions = postgresSchema.decisions;
  const runs = postgresSchema.runs;
  const conditions: SQL[] = [eq(runs.projectId, projectId)];
  if (runId !== undefined) conditions.push(eq(decisions.runId, runId));
  // Same issueRef/workPackIds filters as the sqlite branch above — these
  // were previously missing on the postgres branch (team mode), silently
  // no-opping the issueRef filter there; fixed alongside the workPackId
  // addition rather than left as a divergent bug.
  if (issueRef !== undefined) conditions.push(eq(runs.issueRef, issueRef));
  if (workPackIds !== undefined && workPackIds.length > 0) {
    const workPackConditions = [inArray(runs.workPackId, workPackIds)];
    if (linkedDecisionIds !== undefined && linkedDecisionIds.length > 0) {
      workPackConditions.push(inArray(decisions.id, linkedDecisionIds));
    }
    const combined = workPackConditions.length === 1 ? workPackConditions[0] : or(...workPackConditions);
    if (combined !== undefined) conditions.push(combined);
  }
  if (rankedIds !== undefined)
    conditions.push(
      inArray(
        decisions.id,
        rankedIds.map((r) => r.id),
      ),
    );
  if (activeOnly) {
    conditions.push(sql`
      NOT EXISTS (
        SELECT 1 FROM decision_edges de
        WHERE de.edge_type = 'supersedes'
          AND de.target_type = 'decision'
          AND de.target_id = ${decisions.id}
      )
    `);
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  let selectQuery = db.db
    .select({
      id: decisions.id,
      runId: decisions.runId,
      description: decisions.description,
      rationale: decisions.rationale,
      alternatives: decisions.alternatives,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .innerJoin(runs, eq(decisions.runId, runs.id))
    .where(where)
    .$dynamic();
  if (rankedIds === undefined) selectQuery = selectQuery.orderBy(desc(decisions.createdAt)).limit(limit);
  const rows = (await selectQuery) as RawRow[];
  return rankedIds !== undefined ? sortByRank(rows, rankedIds).slice(0, limit) : rows;
}

/** Reorders `rows` to match `rankedIds`'s best-first order (higher rank = more relevant). */
function sortByRank(rows: RawRow[], rankedIds: ReadonlyArray<RankedId>): RawRow[] {
  const rankById = new Map(rankedIds.map((r) => [r.id, r.rank]));
  return [...rows].sort((a, b) => (rankById.get(b.id) ?? 0) - (rankById.get(a.id) ?? 0));
}

function parseAlternatives(raw: string | null): ReadonlyArray<string> {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
    return [];
  } catch {
    // Older rows may have stored alternatives as a plain text blob
    // (pre-JSON convention). Treat as a single alternative so the
    // value isn't silently lost.
    return raw.length > 0 ? [raw] : [];
  }
}

async function selectSupersededBy(db: DbHandle, decisionIds: ReadonlyArray<string>): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(decisionIds)];
  const supersededBy = new Map<string, string>();
  if (uniqueIds.length === 0) return supersededBy;
  if (db.kind === 'sqlite') {
    const edges = sqliteSchema.decisionEdges;
    const rows = await db.db
      .select({ targetId: edges.targetId, fromDecisionId: edges.fromDecisionId })
      .from(edges)
      .where(and(eq(edges.edgeType, 'supersedes'), eq(edges.targetType, 'decision'), inArray(edges.targetId, uniqueIds)));
    for (const row of rows) if (!supersededBy.has(row.targetId)) supersededBy.set(row.targetId, row.fromDecisionId);
    return supersededBy;
  }
  const edges = postgresSchema.decisionEdges;
  const rows = await db.db
    .select({ targetId: edges.targetId, fromDecisionId: edges.fromDecisionId })
    .from(edges)
    .where(and(eq(edges.edgeType, 'supersedes'), eq(edges.targetType, 'decision'), inArray(edges.targetId, uniqueIds)));
  for (const row of rows) if (!supersededBy.has(row.targetId)) supersededBy.set(row.targetId, row.fromDecisionId);
  return supersededBy;
}

function toEntry(row: RawRow, supersededBy: string | null): DecisionEntry {
  return {
    id: row.id,
    runId: row.runId,
    description: row.description,
    rationale: row.rationale,
    alternatives: [...parseAlternatives(row.alternatives)],
    createdAt: row.createdAt.toISOString(),
    supersededBy,
  };
}

export function createQueryDecisionsHandler(deps: QueryDecisionsHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createQueryDecisionsHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createQueryDecisionsHandler: deps.db must be a DbHandle');
  }

  return async function queryDecisionsHandler(
    input: QueryDecisionsInput,
    ctx: ToolContext,
  ): Promise<QueryDecisionsOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        {
          event: 'query_decisions_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'query_decisions: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    const issueRefFilter = input.issueRef !== undefined ? input.issueRef.toUpperCase() : undefined;

    let workPackIds: string[] | undefined;
    let linkedDecisionIds: string[] | undefined;
    if (input.workPackId !== undefined) {
      workPackIds = [input.workPackId];
      if (input.includeRelated) {
        workPackIds.push(...(await selectRelatedWorkPackIds(deps.db, input.workPackId)));
      }
      linkedDecisionIds = await selectDecisionIdsLinkedToWorkPacks(deps.db, workPackIds);
    }

    const rows = await selectDecisions(
      deps.db,
      projectId,
      input.runId,
      issueRefFilter,
      workPackIds,
      linkedDecisionIds,
      input.query,
      input.activeOnly,
      input.limit,
    );
    const supersededBy = await selectSupersededBy(
      deps.db,
      rows.map((row) => row.id),
    );
    return {
      ok: true,
      decisions: rows.map((row) => toEntry(row, supersededBy.get(row.id) ?? null)),
    };
  };
}
