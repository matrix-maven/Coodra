import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { and, desc, eq, or, sql } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import type { PackResult, SearchPacksNlInput, SearchPacksNlOutput } from './schema.js';

/**
 * Handler factory for `contextos__search_packs_nl`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied semantic-KNN
 * branch was removed. Search is now LIKE over (title, content_excerpt,
 * first 2KB of content), ordered by `created_at DESC`. The agent does
 * relevance ranking by reading candidates via `read_context_pack` and
 * reasoning over them — see `docs/feature-packs/05-agent-driven-nl-
 * assembly/spec.md` §4 for the philosophy.
 *
 * Flow:
 *   1. Resolve `projectSlug` → `projects.id`. Missing → soft-failure.
 *   2. LIKE-match needle against the wider scope. Wider scope catches
 *      keyword hits that landed in the first 2KB of pack body but were
 *      truncated out of `content_excerpt` (which is only 500 chars).
 *   3. Return up to `limit` rows (default 50), newest first, with
 *      `source` field so agents can prefer agent-authored narratives.
 *      No relevance score — `score: null` on every row.
 */

const handlerLogger = createLogger('mcp-server.tool.search_packs_nl');

const DEFAULT_LIMIT = 50 as const;

const PROJECT_NOT_FOUND_HOWTO =
  'Register this project via the Web App or run `contextos init` in the project root before retrying.' as const;

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

async function likeSearch(
  db: DbHandle,
  projectId: string,
  query: string,
  limit: number,
): Promise<ReadonlyArray<PackResult>> {
  const needle = `%${query.toLowerCase()}%`;

  type Row = {
    readonly id: string;
    readonly title: string;
    readonly contentExcerpt: string;
    readonly createdAt: Date;
    readonly runId: string | null;
    readonly source: string;
  };

  let rows: Row[];
  if (db.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    rows = (await db.db
      .select({
        id: cp.id,
        title: cp.title,
        contentExcerpt: cp.contentExcerpt,
        createdAt: cp.createdAt,
        runId: cp.runId,
        source: cp.source,
      })
      .from(cp)
      .where(
        and(
          eq(cp.projectId, projectId),
          or(
            sql`LOWER(${cp.title}) LIKE ${needle}`,
            sql`LOWER(${cp.contentExcerpt}) LIKE ${needle}`,
            // Wider scope (M05): first 2KB of full content. SQLite's substr
            // is 1-indexed; 1..2000 covers the first 2KB.
            sql`LOWER(SUBSTR(${cp.content}, 1, 2000)) LIKE ${needle}`,
          ),
        ),
      )
      .orderBy(desc(cp.createdAt))
      .limit(limit)) as Row[];
  } else {
    const cp = postgresSchema.contextPacks;
    rows = (await db.db
      .select({
        id: cp.id,
        title: cp.title,
        contentExcerpt: cp.contentExcerpt,
        createdAt: cp.createdAt,
        runId: cp.runId,
        source: cp.source,
      })
      .from(cp)
      .where(
        and(
          eq(cp.projectId, projectId),
          or(
            sql`LOWER(${cp.title}) LIKE ${needle}`,
            sql`LOWER(${cp.contentExcerpt}) LIKE ${needle}`,
            sql`LOWER(SUBSTRING(${cp.content}, 1, 2000)) LIKE ${needle}`,
          ),
        ),
      )
      .orderBy(desc(cp.createdAt))
      .limit(limit)) as Row[];
  }

  const packs: PackResult[] = [];
  for (const row of rows) {
    if (row.runId === null) continue;
    // Defensive — schema enforces 'agent'|'bridge_auto' but legacy rows
    // before 0009 default to 'agent' so this should never miss.
    const source = row.source === 'bridge_auto' ? 'bridge_auto' : 'agent';
    packs.push({
      id: row.id,
      title: row.title,
      excerpt: row.contentExcerpt,
      score: null,
      savedAt: row.createdAt.toISOString(),
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
    const packs = await likeSearch(deps.db, projectId, input.query, limit);
    return {
      ok: true,
      packs: packs as PackResult[],
    };
  };
}
