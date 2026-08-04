import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq, sql } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { toSqliteFtsQuery } from '../../lib/fts-query.js';
import type { PackResult, SearchPacksNlInput, SearchPacksNlOutput } from './schema.js';

/**
 * Handler factory for `coodra__search_packs_nl`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied semantic-KNN
 * branch was removed.
 *
 * BM25 full-text search (2026-08-03): replaces the LIKE-substring
 * implementation with real ranked search — SQLite FTS5
 * (`context_packs_fts`) / Postgres generated `tsvector`
 * (`context_packs.search_vector`), both over (title, content_excerpt).
 * Neither column is in the Drizzle TS schema (same convention as the
 * dead `context_packs_vec`/`summaryEmbedding` infra they sit next to —
 * see `packages/db/drizzle/{sqlite,postgres}/00{24,26}_fts_search.sql`),
 * so the query goes through `sql\`...\`` raw fragments rather than typed
 * columns.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects.id`. Missing → soft-failure.
 *   2. Rank-match against title + content_excerpt via bm25()/ts_rank().
 *      Note: unlike the old LIKE search, the first 2KB of full `content`
 *      is no longer separately scanned — FTS indexes title+excerpt only,
 *      matching what the two new preserve-block migrations index.
 *   3. Return up to `limit` rows (default 50), best match first, with
 *      `source` field so agents can prefer agent-authored narratives and
 *      a real `score` (sign-normalized so higher is always better).
 */

const handlerLogger = createLogger('mcp-server.tool.search_packs_nl');

const DEFAULT_LIMIT = 50 as const;

const PROJECT_NOT_FOUND_HOWTO =
  'Register this project via the Web App or run `coodra init` in the project root before retrying.' as const;

export interface SearchPacksNlHandlerDeps {
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

interface FtsRow {
  readonly id: string;
  readonly title: string;
  readonly contentExcerpt: string;
  readonly createdAt: Date | string | number;
  readonly runId: string | null;
  readonly source: string;
  readonly rank: number;
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

async function ftsSearch(
  db: DbHandle,
  projectId: string,
  query: string,
  limit: number,
): Promise<ReadonlyArray<PackResult>> {
  let rows: FtsRow[];
  if (db.kind === 'sqlite') {
    const ftsQuery = toSqliteFtsQuery(query);
    rows = db.db.all<FtsRow>(sql`
      SELECT cp.id AS id, cp.title AS title, cp.content_excerpt AS contentExcerpt,
             cp.created_at AS createdAt, cp.run_id AS runId, cp.source AS source,
             bm25(context_packs_fts) AS rank
      FROM context_packs_fts
      JOIN context_packs cp ON cp.id = context_packs_fts.context_pack_id
      WHERE context_packs_fts MATCH ${ftsQuery} AND cp.project_id = ${projectId}
      ORDER BY rank
      LIMIT ${limit}
    `);
    // SQLite's created_at is stored as unix seconds; the raw query bypasses
    // drizzle's typed timestamp-mode conversion, so it comes back as a
    // plain integer here, not a Date.
    rows = rows.map((row) => ({ ...row, createdAt: toDate((row.createdAt as number) * 1000) }));
  } else {
    rows = (await db.db.execute(sql`
      SELECT cp.id AS id, cp.title AS title, cp.content_excerpt AS "contentExcerpt",
             cp.created_at AS "createdAt", cp.run_id AS "runId", cp.source AS source,
             ts_rank(cp.search_vector, plainto_tsquery('english', ${query})) AS rank
      FROM context_packs cp
      WHERE cp.project_id = ${projectId}
        AND cp.search_vector @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${limit}
    `)) as unknown as FtsRow[];
  }

  const packs: PackResult[] = [];
  for (const row of rows) {
    if (row.runId === null) continue;
    // Defensive — schema enforces 'agent'|'bridge_auto' but legacy rows
    // before 0009 default to 'agent' so this should never miss.
    const source = row.source === 'bridge_auto' ? 'bridge_auto' : 'agent';
    // FTS5's bm25() is natively negative-lower-is-better; ts_rank() is
    // natively positive-higher-is-better. Normalize sqlite's sign so
    // "higher is more relevant" holds for both dialects — see schema.ts's
    // `score` field docblock.
    const score = db.kind === 'sqlite' ? -row.rank : row.rank;
    packs.push({
      id: row.id,
      title: row.title,
      excerpt: row.contentExcerpt,
      score,
      savedAt: toDate(row.createdAt).toISOString(),
      runId: row.runId,
      source,
    });
  }
  return packs;
}

export function createSearchPacksNlHandler(deps: SearchPacksNlHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSearchPacksNlHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createSearchPacksNlHandler: deps.db must be a DbHandle');
  }

  return async function searchPacksNlHandler(
    input: SearchPacksNlInput,
    ctx: ToolContext,
  ): Promise<SearchPacksNlOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'search_packs_nl_project_not_found', projectSlug: input.projectSlug, sessionId: ctx.sessionId },
        'search_packs_nl: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix: PROJECT_NOT_FOUND_HOWTO,
      };
    }

    const limit = input.limit ?? DEFAULT_LIMIT;
    const packs = await ftsSearch(deps.db, projectId, input.query, limit);
    return {
      ok: true,
      packs: packs as PackResult[],
    };
  };
}
