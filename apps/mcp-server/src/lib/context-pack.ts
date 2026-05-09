import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { type Logger, ValidationError } from '@coodra/contextos-shared';
import {
  contextPackFilename as sharedContextPackFilename,
  defaultContextPacksRoot as sharedDefaultContextPacksRoot,
} from '@coodra/contextos-shared/context-pack-paths';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ContextPackStore } from '../framework/tool-context.js';
import { createMcpLogger } from './logger.js';

/**
 * `apps/mcp-server/src/lib/context-pack.ts` — DB-first Context-Pack
 * store wired into `ToolContext.contextPack`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied path was
 * removed entirely. The store no longer accepts a `Float32Array`
 * second argument — it accepts an `options` object with `source`
 * ('agent' | 'bridge_auto') and optional `meta` (JSON-encodable
 * agent-curated metadata). See
 * `docs/feature-packs/05-agent-driven-nl-assembly/spec.md` §5.4 for
 * the source semantics — including the single ADR-007 relaxation
 * that lets an agent-explicit save overwrite a bridge_auto row.
 *
 * Write flow:
 *   1. Validate the `pack` payload with a module-local Zod schema.
 *   2. Compute `content_excerpt` = first 500 Unicode CODE POINTS of
 *      `content` with trailing whitespace trimmed. Emoji + CJK at
 *      position 499 survive.
 *   3. Idempotency check by `runId`:
 *        - No existing row → INSERT with the supplied `source`.
 *        - Existing row with `source='bridge_auto'` AND incoming call
 *          has `source='agent'` → UPDATE content + flip source. This
 *          is the M05 single ADR-007 relaxation.
 *        - Otherwise → no-op, return the existing row.
 *   4. Materialise the on-disk markdown file under
 *      `docs/context-packs/YYYY-MM-DD-<runId-first-8>.md`. Failure is
 *      non-fatal — DB is source of truth.
 */

const contextPackLogger = createMcpLogger('lib-context-pack');

const EXCERPT_MAX_CODE_POINTS = 500 as const;

// ---------------------------------------------------------------------------
// Pack payload schema
// ---------------------------------------------------------------------------

const packSchema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  featurePackId: z.string().min(1).optional(),
});
export type ContextPackInput = z.infer<typeof packSchema>;

/**
 * Optional metadata the agent supplies on `save_context_pack`. Stored as
 * JSON-encoded text in `context_packs.meta`. Validated at the tool
 * boundary (see save-context-pack/schema.ts) — this layer trusts the
 * shape and only does a minimal sanity check.
 */
export interface ContextPackMeta {
  readonly decisionIds?: ReadonlyArray<string>;
  readonly affectedFiles?: ReadonlyArray<string>;
  readonly testStatus?: 'pass' | 'fail' | 'skip' | 'unknown';
  readonly openTodos?: ReadonlyArray<string>;
}

export type ContextPackSource = 'agent' | 'bridge_auto';

export interface ContextPackWriteOptions {
  readonly source: ContextPackSource;
  readonly meta?: ContextPackMeta;
}

export interface ContextPackWriteResult {
  readonly id: string;
  readonly runId: string;
  readonly createdAt: Date;
  readonly contentExcerpt: string;
  readonly filePath: string | null;
  readonly source: ContextPackSource;
  /** 'created' | 'idempotent_hit' | 'upgraded_from_bridge_auto'. Lets callers tell apart. */
  readonly status: 'created' | 'idempotent_hit' | 'upgraded_from_bridge_auto';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unicode code-point-safe excerpt. `String.prototype.slice(0, N)`
 * operates on UTF-16 code units and splits surrogate pairs mid-
 * character for emoji and supplementary-plane CJK. `Array.from`
 * iterates code points, so slicing the resulting array preserves
 * whole characters. Also trims trailing whitespace so a run of
 * newlines at the end doesn't poison LIKE search.
 */
export function computeContentExcerpt(content: string, max: number = EXCERPT_MAX_CODE_POINTS): string {
  if (typeof content !== 'string') return '';
  const chars = Array.from(content);
  const sliced = chars.length <= max ? chars : chars.slice(0, max);
  return sliced.join('').replace(/\s+$/u, '');
}

export const defaultContextPacksRoot = sharedDefaultContextPacksRoot;
export const contextPackFilename = sharedContextPackFilename;

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function selectByRunId(db: DbHandle, runId: string) {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select()
      .from(sqliteSchema.contextPacks)
      .where(eq(sqliteSchema.contextPacks.runId, runId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select()
    .from(postgresSchema.contextPacks)
    .where(eq(postgresSchema.contextPacks.runId, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function insertRow(
  db: DbHandle,
  row: {
    readonly id: string;
    readonly runId: string;
    readonly projectId: string;
    readonly title: string;
    readonly content: string;
    readonly contentExcerpt: string;
    readonly source: ContextPackSource;
    readonly metaJson: string | null;
  },
): Promise<{ readonly createdAt: Date }> {
  if (db.kind === 'sqlite') {
    const baseRow = {
      id: row.id,
      runId: row.runId,
      projectId: row.projectId,
      title: row.title,
      content: row.content,
      contentExcerpt: row.contentExcerpt,
      source: row.source,
      meta: row.metaJson,
    };
    const inserted = await db.db
      .insert(sqliteSchema.contextPacks)
      .values(baseRow)
      .returning({ id: sqliteSchema.contextPacks.id, createdAt: sqliteSchema.contextPacks.createdAt });
    return { createdAt: inserted[0]?.createdAt ?? new Date() };
  }
  const values = {
    id: row.id,
    runId: row.runId,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    contentExcerpt: row.contentExcerpt,
    source: row.source,
    meta: row.metaJson,
  };
  const inserted = await db.db
    .insert(postgresSchema.contextPacks)
    .values(values as typeof postgresSchema.contextPacks.$inferInsert)
    .returning({ id: postgresSchema.contextPacks.id, createdAt: postgresSchema.contextPacks.createdAt });
  return { createdAt: inserted[0]?.createdAt ?? new Date() };
}

async function upgradeBridgeAutoToAgent(
  db: DbHandle,
  rowId: string,
  payload: {
    readonly title: string;
    readonly content: string;
    readonly contentExcerpt: string;
    readonly metaJson: string | null;
  },
): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.contextPacks)
      .set({
        title: payload.title,
        content: payload.content,
        contentExcerpt: payload.contentExcerpt,
        source: 'agent',
        meta: payload.metaJson,
      })
      .where(eq(sqliteSchema.contextPacks.id, rowId));
    return;
  }
  await db.db
    .update(postgresSchema.contextPacks)
    .set({
      title: payload.title,
      content: payload.content,
      contentExcerpt: payload.contentExcerpt,
      source: 'agent',
      meta: payload.metaJson,
    })
    .where(eq(postgresSchema.contextPacks.id, rowId));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateContextPackStoreDeps {
  readonly db: DbHandle;
  /** Root for on-disk `YYYY-MM-DD-<runId>.md` files. Defaults to `${cwd}/docs/context-packs`. */
  readonly contextPacksRoot?: string;
  readonly logger?: Logger;
}

export function createContextPackStore(deps: CreateContextPackStoreDeps): ContextPackStore {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createContextPackStore requires an options object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createContextPackStore: deps.db must be a DbHandle from @coodra/contextos-db');
  }
  const log = deps.logger ?? contextPackLogger;
  const contextPacksRoot = deps.contextPacksRoot ?? defaultContextPacksRoot();

  log.info(
    { event: 'context_pack_store_wired', contextPacksRoot, mode: 'agent_driven_m05' },
    'createContextPackStore: DB-first store wired (FS is reconcilable, no embedding pipeline).',
  );

  return {
    async write(pack, options) {
      const parsed = packSchema.safeParse(pack);
      if (!parsed.success) {
        throw new ValidationError(
          `context-pack.write: invalid pack payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        );
      }
      const input = parsed.data;
      const writeOptions: ContextPackWriteOptions = options ?? { source: 'agent' };
      const incomingSource: ContextPackSource = writeOptions.source ?? 'agent';
      const metaJson =
        writeOptions.meta !== undefined && writeOptions.meta !== null ? JSON.stringify(writeOptions.meta) : null;
      const contentExcerpt = computeContentExcerpt(input.content);

      // Idempotency per runId. The unique index on context_packs(run_id)
      // is the enforcing layer; this shortcut handles both no-op and the
      // single ADR-007 relaxation (bridge_auto -> agent upgrade).
      const existing = await selectByRunId(deps.db, input.runId);
      if (existing) {
        if (existing.source === 'bridge_auto' && incomingSource === 'agent') {
          // M05 narrow upgrade-in-place. Replace content with the agent's
          // canonical narrative and flip the source flag.
          await upgradeBridgeAutoToAgent(deps.db, existing.id, {
            title: input.title,
            content: input.content,
            contentExcerpt,
            metaJson,
          });
          log.info(
            { event: 'context_pack_upgraded_from_bridge_auto', runId: input.runId, id: existing.id },
            'context-pack.write: upgraded bridge_auto row to agent-authored',
          );
          // Re-write the FS materialisation too — non-fatal if it fails.
          let filePath: string | null = null;
          try {
            await mkdir(contextPacksRoot, { recursive: true });
            const filename = contextPackFilename(input.runId, existing.createdAt);
            const fullPath = resolve(contextPacksRoot, filename);
            await writeFile(fullPath, input.content, 'utf8');
            filePath = fullPath;
          } catch (err) {
            log.warn(
              {
                event: 'context_pack_fs_upgrade_write_failed',
                runId: input.runId,
                err: err instanceof Error ? err.message : String(err),
              },
              'context-pack.write: upgrade DB succeeded but FS write failed — row is durable, FS reconcilable',
            );
          }
          return {
            id: existing.id,
            runId: existing.runId,
            createdAt: existing.createdAt,
            contentExcerpt,
            filePath,
            source: 'agent',
            status: 'upgraded_from_bridge_auto',
          };
        }
        // Same-source re-call OR agent->bridge_auto downgrade attempt.
        // Both are no-ops. Return existing row's shape unchanged.
        log.info(
          {
            event: 'context_pack_idempotent_hit',
            runId: input.runId,
            id: existing.id,
            existingSource: existing.source,
            incomingSource,
          },
          'context-pack.write: row already exists for runId — returning existing shape',
        );
        return {
          id: existing.id,
          runId: existing.runId,
          createdAt: existing.createdAt,
          contentExcerpt: existing.contentExcerpt,
          filePath: null,
          source: existing.source === 'bridge_auto' ? 'bridge_auto' : 'agent',
          status: 'idempotent_hit',
        };
      }

      const id = `cp_${randomUUID()}`;
      const { createdAt } = await insertRow(deps.db, {
        id,
        runId: input.runId,
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        contentExcerpt,
        source: incomingSource,
        metaJson,
      });

      // Materialise FS view. Failure is non-fatal — DB is source of truth.
      let filePath: string | null = null;
      try {
        await mkdir(contextPacksRoot, { recursive: true });
        const filename = contextPackFilename(input.runId, createdAt);
        const fullPath = resolve(contextPacksRoot, filename);
        await writeFile(fullPath, input.content, 'utf8');
        filePath = fullPath;
      } catch (err) {
        log.warn(
          {
            event: 'context_pack_fs_write_failed',
            runId: input.runId,
            contextPacksRoot,
            err: err instanceof Error ? err.message : String(err),
          },
          'context-pack.write: DB insert succeeded but FS materialise failed; row is durable, FS is reconcilable',
        );
      }

      return {
        id,
        runId: input.runId,
        createdAt,
        contentExcerpt,
        filePath,
        source: incomingSource,
        status: 'created',
      };
    },

    async read(runId) {
      if (typeof runId !== 'string' || runId.length === 0) {
        throw new ValidationError('context-pack.read: runId is required');
      }
      const row = await selectByRunId(deps.db, runId);
      if (!row) return null;
      return row;
    },

    async list(filter) {
      const limit = typeof filter.limit === 'number' && filter.limit > 0 ? Math.min(filter.limit, 200) : 50;
      if (deps.db.kind === 'sqlite') {
        const cp = sqliteSchema.contextPacks;
        const conditions = [];
        if (filter.runId) conditions.push(eq(cp.runId, filter.runId));
        if (filter.projectSlug) {
          const projectRows = await deps.db.db
            .select({ id: sqliteSchema.projects.id })
            .from(sqliteSchema.projects)
            .where(eq(sqliteSchema.projects.slug, filter.projectSlug))
            .limit(1);
          const projectId = projectRows[0]?.id;
          if (!projectId) return [];
          conditions.push(eq(cp.projectId, projectId));
        }
        const where =
          conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
        const rows = await (where
          ? deps.db.db.select().from(cp).where(where).orderBy(desc(cp.createdAt)).limit(limit)
          : deps.db.db.select().from(cp).orderBy(desc(cp.createdAt)).limit(limit));
        return rows;
      }
      const cp = postgresSchema.contextPacks;
      const conditions = [];
      if (filter.runId) conditions.push(eq(cp.runId, filter.runId));
      if (filter.projectSlug) {
        const projectRows = await deps.db.db
          .select({ id: postgresSchema.projects.id })
          .from(postgresSchema.projects)
          .where(eq(postgresSchema.projects.slug, filter.projectSlug))
          .limit(1);
        const projectId = projectRows[0]?.id;
        if (!projectId) return [];
        conditions.push(eq(cp.projectId, projectId));
      }
      const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
      const rows = await (where
        ? deps.db.db.select().from(cp).where(where).orderBy(desc(cp.createdAt)).limit(limit)
        : deps.db.db.select().from(cp).orderBy(desc(cp.createdAt)).limit(limit));
      return rows;
    },
  };
}
