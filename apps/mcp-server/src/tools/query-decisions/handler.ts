import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { and, desc, eq, like, or } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import type { DecisionEntry, QueryDecisionsInput, QueryDecisionsOutput } from './schema.js';

/**
 * Handler factory for `contextos__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + the decisions SELECT joined to runs.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects.id`. Missing →
 *      `{ ok: false, error: 'project_not_found', howToFix }` per §9.1.2.
 *   2. SELECT decisions.* JOIN runs ON decisions.run_id = runs.id
 *      WHERE runs.project_id = ?
 *        [AND decisions.run_id = ?]
 *        [AND (description LIKE %query% OR rationale LIKE %query%)]
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

interface RawRow {
  readonly id: string;
  readonly runId: string;
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly createdAt: Date;
}

async function selectDecisions(
  db: DbHandle,
  projectId: string,
  runId: string | undefined,
  query: string | undefined,
  limit: number,
): Promise<RawRow[]> {
  if (db.kind === 'sqlite') {
    const decisions = sqliteSchema.decisions;
    const runs = sqliteSchema.runs;
    const conditions = [eq(runs.projectId, projectId)];
    if (runId !== undefined) conditions.push(eq(decisions.runId, runId));
    if (query !== undefined) {
      const pattern = `%${query}%`;
      const text = or(like(decisions.description, pattern), like(decisions.rationale, pattern));
      if (text !== undefined) conditions.push(text);
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = await db.db
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
      .orderBy(desc(decisions.createdAt))
      .limit(limit);
    return rows as RawRow[];
  }
  const decisions = postgresSchema.decisions;
  const runs = postgresSchema.runs;
  const conditions = [eq(runs.projectId, projectId)];
  if (runId !== undefined) conditions.push(eq(decisions.runId, runId));
  if (query !== undefined) {
    const pattern = `%${query}%`;
    const text = or(like(decisions.description, pattern), like(decisions.rationale, pattern));
    if (text !== undefined) conditions.push(text);
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const rows = await db.db
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
    .orderBy(desc(decisions.createdAt))
    .limit(limit);
  return rows as RawRow[];
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

function toEntry(row: RawRow): DecisionEntry {
  return {
    id: row.id,
    runId: row.runId,
    description: row.description,
    rationale: row.rationale,
    alternatives: [...parseAlternatives(row.alternatives)],
    createdAt: row.createdAt.toISOString(),
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
          'Register the project via the CLI (`contextos init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    const rows = await selectDecisions(deps.db, projectId, input.runId, input.query, input.limit);
    return {
      ok: true,
      decisions: rows.map(toEntry),
    };
  };
}
