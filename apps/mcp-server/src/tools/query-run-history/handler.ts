import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import type { QueryRunHistoryInput, QueryRunHistoryOutput, RunHistoryEntry } from './schema.js';

/**
 * Handler factory for `coodra__query_run_history` (§24.4, S12).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + the runs SELECT with the optional
 * `context_packs` LEFT JOIN for `title`.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects.id`. Missing →
 *      `{ ok: false, error: 'project_not_found', howToFix }` per §9.1.2.
 *   2. SELECT runs.* LEFT JOIN context_packs ON runs.id = context_packs.run_id
 *      WHERE runs.project_id = ? [AND runs.status = ?]
 *      ORDER BY runs.started_at DESC
 *      LIMIT ?
 *      — `title` comes from the joined pack (null for runs with no pack
 *      yet; the unique index on `context_packs(run_id)` guarantees at
 *      most one join row per run).
 *   3. Map rows: Date → ISO string; endedAt/title/issueRef/prRef
 *      pass through with the DB's null.
 *
 * Read-only: no RunRecorder emit, no policy_decisions write. No
 * auto-create on project-miss (symmetric with `search_packs_nl`).
 */

const handlerLogger = createLogger('mcp-server.tool.query_run_history');

export interface QueryRunHistoryHandlerDeps {
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

type RunStatus = 'in_progress' | 'completed' | 'failed' | 'abandoned';

interface RawRow {
  readonly runId: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly status: string;
  readonly title: string | null;
  readonly issueRef: string | null;
  readonly prRef: string | null;
}

async function selectRuns(
  db: DbHandle,
  projectId: string,
  status: RunStatus | undefined,
  limit: number,
): Promise<RawRow[]> {
  if (db.kind === 'sqlite') {
    const runs = sqliteSchema.runs;
    const packs = sqliteSchema.contextPacks;
    const where =
      status === undefined
        ? eq(runs.projectId, projectId)
        : and(eq(runs.projectId, projectId), eq(runs.status, status));
    const rows = await db.db
      .select({
        runId: runs.id,
        startedAt: runs.startedAt,
        endedAt: runs.endedAt,
        status: runs.status,
        title: packs.title,
        issueRef: runs.issueRef,
        prRef: runs.prRef,
      })
      .from(runs)
      .leftJoin(packs, eq(packs.runId, runs.id))
      .where(where)
      .orderBy(desc(runs.startedAt))
      .limit(limit);
    return rows as RawRow[];
  }
  const runs = postgresSchema.runs;
  const packs = postgresSchema.contextPacks;
  const where =
    status === undefined ? eq(runs.projectId, projectId) : and(eq(runs.projectId, projectId), eq(runs.status, status));
  const rows = await db.db
    .select({
      runId: runs.id,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      status: runs.status,
      title: packs.title,
      issueRef: runs.issueRef,
      prRef: runs.prRef,
    })
    .from(runs)
    .leftJoin(packs, eq(packs.runId, runs.id))
    .where(where)
    .orderBy(desc(runs.startedAt))
    .limit(limit);
  return rows as RawRow[];
}

function toEntry(row: RawRow): RunHistoryEntry {
  const status: RunStatus =
    row.status === 'in_progress' || row.status === 'completed' || row.status === 'failed' || row.status === 'abandoned'
      ? row.status
      : 'in_progress';
  return {
    runId: row.runId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    status,
    title: row.title,
    issueRef: row.issueRef,
    prRef: row.prRef,
  };
}

export function createQueryRunHistoryHandler(deps: QueryRunHistoryHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createQueryRunHistoryHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createQueryRunHistoryHandler: deps.db must be a DbHandle');
  }

  return async function queryRunHistoryHandler(
    input: QueryRunHistoryInput,
    ctx: ToolContext,
  ): Promise<QueryRunHistoryOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        {
          event: 'query_run_history_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: ctx.sessionId,
        },
        'query_run_history: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    const rows = await selectRuns(deps.db, projectId, input.status, input.limit);
    return {
      ok: true,
      runs: rows.map(toEntry),
    };
  };
}
