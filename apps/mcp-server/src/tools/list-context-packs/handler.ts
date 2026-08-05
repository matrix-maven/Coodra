import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';

import type { ToolContext } from '../../framework/tool-context.js';
import {
  LIST_CONTEXT_PACKS_DEFAULT_LIMIT,
  type ListContextPacksInput,
  type ListContextPacksOutput,
  type ListContextPacksRow,
} from './schema.js';

/**
 * Handler factory for `coodra__list_context_packs`.
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

/**
 * Append-only redesign (2026-08-05). Agent-facing filter uses the same
 * slug convention as `save_context_pack`'s `workPackSlug` /
 * `record_decision`'s `workPackSlugs` — agents work with slugs
 * everywhere else, never raw Work Pack ids.
 */
async function resolveWorkPackId(db: DbHandle, projectId: string, slug: string): Promise<string | null> {
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
 * Context Pack ids linked to `workPackId` via the many-to-many
 * `work_pack_context_pack_links` table (`save_context_pack`'s
 * `alsoLinkWorkPackSlugs`) — additive to, and composed with, the
 * primary `context_packs.work_pack_id` match below, mirroring how
 * `query_decisions` already composes `workPackDecisionLinks` with the
 * transitive `runs.work_pack_id` match. Without this, a pack linked
 * only secondarily to a Work Pack was invisible to this filter.
 */
async function selectContextPackIdsLinkedToWorkPack(db: DbHandle, workPackId: string): Promise<string[]> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ contextPackId: sqliteSchema.workPackContextPackLinks.contextPackId })
      .from(sqliteSchema.workPackContextPackLinks)
      .where(eq(sqliteSchema.workPackContextPackLinks.workPackId, workPackId));
    return rows.map((r) => r.contextPackId);
  }
  const rows = await db.db
    .select({ contextPackId: postgresSchema.workPackContextPackLinks.contextPackId })
    .from(postgresSchema.workPackContextPackLinks)
    .where(eq(postgresSchema.workPackContextPackLinks.workPackId, workPackId));
  return rows.map((r) => r.contextPackId);
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
        howToFix: 'Register this project via the Web App or run `coodra init` in the project root before retrying.',
      };
    }

    let workPackId: string | null = null;
    let linkedContextPackIds: string[] = [];
    if (input.workPackSlug !== undefined) {
      workPackId = await resolveWorkPackId(deps.db, projectId, input.workPackSlug);
      if (workPackId === null) {
        handlerLogger.info(
          {
            event: 'list_context_packs_work_pack_not_found',
            projectSlug: input.projectSlug,
            workPackSlug: input.workPackSlug,
            sessionId: ctx.sessionId,
          },
          'list_context_packs: workPackSlug did not resolve to a Work Pack — returning an empty page',
        );
        return { ok: true, packs: [], nextCursor: null };
      }
      linkedContextPackIds = await selectContextPackIdsLinkedToWorkPack(deps.db, workPackId);
    }

    const limit = input.limit ?? LIST_CONTEXT_PACKS_DEFAULT_LIMIT;

    let cursor: DecodedCursor | null = null;
    if (input.cursor !== undefined && input.cursor.length > 0) {
      cursor = decodeCursor(input.cursor);
      if (cursor === null) {
        return {
          ok: false,
          error: 'malformed_cursor',
          howToFix: "Pass a `cursor` value from a prior call's `nextCursor`, or omit it to start from the newest pack.",
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
      readonly kind: string | null;
    };

    let rows: Row[];
    if (deps.db.kind === 'sqlite') {
      const cp = sqliteSchema.contextPacks;
      const baseCondition =
        workPackId !== null
          ? and(
              eq(cp.projectId, projectId),
              // Matches either the primary context_packs.work_pack_id
              // column OR a secondary work_pack_context_pack_links tag
              // (save_context_pack's alsoLinkWorkPackSlugs) — mirrors
              // how query_decisions composes workPackDecisionLinks.
              linkedContextPackIds.length > 0
                ? or(eq(cp.workPackId, workPackId), inArray(cp.id, linkedContextPackIds))
                : eq(cp.workPackId, workPackId),
            )
          : eq(cp.projectId, projectId);
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
          kind: cp.kind,
        })
        .from(cp)
        .where(whereCondition)
        .orderBy(desc(cp.createdAt), desc(cp.id))
        .limit(limit + 1)) as Row[];
    } else {
      const cp = postgresSchema.contextPacks;
      const baseCondition =
        workPackId !== null
          ? and(
              eq(cp.projectId, projectId),
              linkedContextPackIds.length > 0
                ? or(eq(cp.workPackId, workPackId), inArray(cp.id, linkedContextPackIds))
                : eq(cp.workPackId, workPackId),
            )
          : eq(cp.projectId, projectId);
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
          kind: cp.kind,
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
        kind: r.kind,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined
        ? encodeCursor({ lastCreatedAt: lastRow.createdAt.getTime(), lastId: lastRow.id })
        : null;

    return {
      ok: true,
      packs,
      nextCursor,
    };
  };
}
