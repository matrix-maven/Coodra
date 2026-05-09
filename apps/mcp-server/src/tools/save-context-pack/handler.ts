import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import type { ContextPackWriteResult } from '../../lib/context-pack.js';
import type { SaveContextPackInput, SaveContextPackOutput } from './schema.js';

/**
 * Handler factory for `contextos__save_context_pack` (§24.4).
 *
 * Factory shape (not bare static) because the handler closes over a
 * `DbHandle` for the `runs` SELECT + UPDATE. `ctx.contextPack` is
 * wired via `ContextDeps` and handles the `context_packs` write
 * itself (DB-first, Unicode-code-point excerpt, FS materialisation,
 * idempotent-per-runId, append-only re-call — see S7c decisions-log).
 *
 * Flow:
 *   1. SELECT `runs.projectId` for the supplied `runId`. Missing →
 *      structured `{ ok: false, error: 'run_not_found', howToFix }`
 *      soft-failure per §9.1.2 canonical shape.
 *   2. Delegate to `ctx.contextPack.write(pack, null)` — embedding is
 *      null in Module 02 (Module 05 NL Assembly backfills later; S7c
 *      decisions-log 2026-04-24 12:30 keeps the embedding-write path
 *      on the store, not on a separate client).
 *   3. UPDATE `runs SET status = 'completed', endedAt = now()
 *      WHERE id = runId AND status != 'completed'` — idempotent
 *      no-op when the run is already completed (matches §24.4
 *      "returns the existing pack (idempotent)").
 *   4. Return `{ ok: true, contextPackId, savedAt, contentExcerpt }`.
 *
 * `featurePackId` is accepted from the caller and passed through to
 * the store, which currently discards it (no FK column on
 * `context_packs`). Retained for M05/M07 schema growth.
 *
 * No policy-decision audit write — S14 (`check_policy`) remains the
 * first caller of `recordPolicyDecision`.
 */

const handlerLogger = createLogger('mcp-server.tool.save_context_pack');

export interface SaveContextPackHandlerDeps {
  readonly db: DbHandle;
}

async function selectRunProjectId(db: DbHandle, runId: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ projectId: sqliteSchema.runs.projectId })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }
  const rows = await db.db
    .select({ projectId: postgresSchema.runs.projectId })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

async function markRunCompleted(db: DbHandle, runId: string): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db
      .update(sqliteSchema.runs)
      .set({
        status: 'completed',
        endedAt: sql`(unixepoch())` as unknown as Date,
      })
      .where(and(eq(sqliteSchema.runs.id, runId), ne(sqliteSchema.runs.status, 'completed')));
    return;
  }
  await db.db
    .update(postgresSchema.runs)
    .set({
      status: 'completed',
      endedAt: sql`now()` as unknown as Date,
    })
    .where(and(eq(postgresSchema.runs.id, runId), ne(postgresSchema.runs.status, 'completed')));
}

export function createSaveContextPackHandler(deps: SaveContextPackHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createSaveContextPackHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createSaveContextPackHandler: deps.db must be a DbHandle');
  }

  return async function saveContextPackHandler(
    input: SaveContextPackInput,
    ctx: ToolContext,
  ): Promise<SaveContextPackOutput> {
    const projectId = await selectRunProjectId(deps.db, input.runId);
    if (projectId === null) {
      handlerLogger.info(
        { event: 'save_context_pack_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'save_context_pack: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to create a run for this session, then retry save_context_pack with the returned runId.',
      };
    }

    // Module 05: explicit MCP-tool calls always carry source='agent'.
    // The bridge's auto-pack path (auto-context-pack.ts) bypasses this
    // tool and writes directly via the store with source='bridge_auto'.
    const written = (await ctx.contextPack.write(
      {
        runId: input.runId,
        projectId,
        title: input.title,
        content: input.content,
        ...(input.featurePackId !== undefined ? { featurePackId: input.featurePackId } : {}),
      },
      {
        source: 'agent',
        ...(input.meta !== undefined ? { meta: input.meta } : {}),
      },
    )) as ContextPackWriteResult;

    // Mark the run completed — idempotent no-op if already completed.
    // Runs after the store write so that the context_packs row exists
    // before the run's lifecycle marker flips (avoids the narrow
    // window where a crashed process could leave a 'completed' run
    // with no pack).
    await markRunCompleted(deps.db, input.runId);

    return {
      ok: true,
      contextPackId: written.id,
      savedAt: written.createdAt.toISOString(),
      contentExcerpt: written.contentExcerpt,
      source: written.source,
      status: written.status,
    };
  };
}
