import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { and, desc, eq, lt, or } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import {
  LIST_CONTEXT_PACKS_DEFAULT_LIMIT,
  type ListContextPacksInput,
  type ListContextPacksOutput,
  type ListContextPacksRow,
} from './schema.js';

/**
 * Handler factory for `contextos__list_context_packs`.
 *
 * Module 05 §5.1. Pagination via opaque base64 cursor encoding
 * `{lastCreatedAt: number_ms, lastId: string}`. The keyset condition
 * `(created_at, id) < (lastCreatedAt, lastId)` keeps the scan stable
 * across same-second ties.
 */

const handlerLogger = createLogger('mcp-server.tool.list_context_packs');

export interface ListContextPacksHandlerDeps {
  readonly db: DbHandle;
}

interface DecodedCursor {
  readonly lastCreatedAt: number; // ms-since-epoch
  readonly lastId: string;
}

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'lastCreatedAt' in parsed &&
      'lastId' in parsed &&
      typeof (parsed as { lastCreatedAt: unknown }).lastCreatedAt === 'number' &&
      typeof (parsed as { lastId: unknown }).lastId === 'string'
    ) {
      const c = parsed as { lastCreatedAt: number; lastId: string };
      if (c.lastId.length === 0 || !Number.isFinite(c.lastCreatedAt)) return null;
      return { lastCreatedAt: c.lastCreatedAt, lastId: c.lastId };
    }
    return null;
  } catch {
    return null;
  }
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

export function createListContextPacksHandler(deps: ListContextPacksHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createListContextPacksHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createListContextPacksHandler: deps.db must be a DbHandle');
  }

  return async function listContextPacksHandler(
    input: ListContextPacksInput,
    ctx: ToolContext,
  ): Promise<ListContextPacksOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'list_context_packs_project_not_found', projectSlug: input.projectSlug, sessionId: ctx.sessionId },
        'list_context_packs: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register this project via the Web App or run `contextos init` in the project root before retrying.',
      };
    }

    const limit = input.limit ?? LIST_CONTEXT_PACKS_DEFAULT_LIMIT;

    let cursor: DecodedCursor | null = null;
    if (input.cursor !== undefined && input.cursor.length > 0) {
      cursor = decodeCursor(input.cursor);
      if (cursor === null) {
        return {
          ok: false,
          error: 'malformed_cursor',
          howToFix: 'Pass a `cursor` value from a prior call\'s `nextCursor`, or omit it to start from the newest pack.',
        };
      }
    }

    type Row = {
      readonly id: string;
      readonly title: string;
      readonly contentExcerpt: string;
      readonly createdAt: Date;
      readonly runId: string | null;
      readonly source: string;
    };

    let rows: Row[];
    if (deps.db.kind === 'sqlite') {
      const cp = sqliteSchema.contextPacks;
      const baseCondition = eq(cp.projectId, projectId);
      const whereCondition =
        cursor !== null
          ? and(
              baseCondition,
              or(
                lt(cp.createdAt, new Date(cursor.lastCreatedAt)),
                and(eq(cp.createdAt, new Date(cursor.lastCreatedAt)), lt(cp.id, cursor.lastId)),
              ),
            )
          : baseCondition;
      rows = (await deps.db.db
        .select({
          id: cp.id,
          title: cp.title,
          contentExcerpt: cp.contentExcerpt,
          createdAt: cp.createdAt,
          runId: cp.runId,
          source: cp.source,
        })
        .from(cp)
        .where(whereCondition)
        .orderBy(desc(cp.createdAt), desc(cp.id))
        .limit(limit + 1)) as Row[];
    } else {
      const cp = postgresSchema.contextPacks;
      const baseCondition = eq(cp.projectId, projectId);
      const whereCondition =
        cursor !== null
          ? and(
              baseCondition,
              or(
                lt(cp.createdAt, new Date(cursor.lastCreatedAt)),
                and(eq(cp.createdAt, new Date(cursor.lastCreatedAt)), lt(cp.id, cursor.lastId)),
              ),
            )
          : baseCondition;
      rows = (await deps.db.db
        .select({
          id: cp.id,
          title: cp.title,
          contentExcerpt: cp.contentExcerpt,
          createdAt: cp.createdAt,
          runId: cp.runId,
          source: cp.source,
        })
        .from(cp)
        .where(whereCondition)
        .orderBy(desc(cp.createdAt), desc(cp.id))
        .limit(limit + 1)) as Row[];
    }

    // Read one extra row to detect "is there more?" without a count query.
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const packs: ListContextPacksRow[] = [];
    for (const r of pageRows) {
      if (r.runId === null) continue;
      const source = r.source === 'bridge_auto' ? 'bridge_auto' : 'agent';
      packs.push({
        id: r.id,
        title: r.title,
        excerpt: r.contentExcerpt,
        savedAt: r.createdAt.toISOString(),
        runId: r.runId,
        source,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && lastRow !== undefined
      ? encodeCursor({ lastCreatedAt: lastRow.createdAt.getTime(), lastId: lastRow.id })
      : null;

    return {
      ok: true,
      packs,
      nextCursor,
    };
  };
}
