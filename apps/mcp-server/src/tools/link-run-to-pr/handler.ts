import { type DbHandle, postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import type { LinkRunToPrInput, LinkRunToPrOutput } from './schema.js';

/**
 * Handler factory for `coodra__link_run_to_pr` — sibling to
 * `link_run_to_issue`, writing `runs.pr_ref` instead of `runs.issue_ref`.
 *
 * Flow (identical shape to `link_run_to_issue`):
 *   1. SELECT runs(id, pr_ref) for `input.runId`. Missing → structured
 *      `{ ok: false, error: 'run_not_found', howToFix }` soft-failure.
 *   2. No case normalisation (PR refs aren't conventionally uppercase).
 *   3. If the run is already bound to that exact ref → idempotent no-op
 *      (`updated: false`, no write).
 *   4. Else UPDATE runs SET pr_ref = ref WHERE id = runId.
 *   5. Team mode: enqueue a `sync_to_cloud` job for the runs row (by id).
 *      Solo mode skips (no cloud).
 *
 * No provider API call ever happens here — the tool records a local link
 * only. The agent verifies the PR/MR exists via its own provider MCP if
 * needed.
 */

const handlerLogger = createLogger('mcp-server.tool.link_run_to_pr');

export interface LinkRunToPrHandlerDeps {
  readonly db: DbHandle;
}

/** SELECT the run's id + current pr_ref, or null when no such run. */
async function selectRun(
  db: DbHandle,
  runId: string,
): Promise<{ readonly id: string; readonly prRef: string | null } | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.runs.id, prRef: sqliteSchema.runs.prRef })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.runs.id, prRef: postgresSchema.runs.prRef })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/** UPDATE runs.pr_ref for the given run id (both dialects). */
async function updatePrRef(db: DbHandle, runId: string, prRef: string): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.runs).set({ prRef }).where(eq(sqliteSchema.runs.id, runId));
    return;
  }
  await db.db.update(postgresSchema.runs).set({ prRef }).where(eq(postgresSchema.runs.id, runId));
}

export function createLinkRunToPrHandler(deps: LinkRunToPrHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createLinkRunToPrHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createLinkRunToPrHandler: deps.db must be a DbHandle');
  }

  return async function linkRunToPrHandler(input: LinkRunToPrInput, ctx: ToolContext): Promise<LinkRunToPrOutput> {
    const prRef = input.prRef.trim();

    const run = await selectRun(deps.db, input.runId);
    if (run === null) {
      handlerLogger.info(
        { event: 'link_run_to_pr_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'link_run_to_pr: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix: 'Call get_run_id first to obtain a runId for this session, then retry link_run_to_pr with that runId.',
      };
    }

    const previousPrRef = run.prRef;

    // Idempotent: already bound to this exact ref → no write.
    if (previousPrRef === prRef) {
      handlerLogger.info(
        { event: 'link_run_to_pr_unchanged', runId: input.runId, prRef, sessionId: ctx.sessionId },
        'link_run_to_pr: run already bound to this PR/MR — no-op',
      );
      return { ok: true, runId: input.runId, prRef, previousPrRef, updated: false };
    }

    await updatePrRef(deps.db, input.runId, prRef);
    handlerLogger.info(
      {
        event: 'link_run_to_pr_updated',
        runId: input.runId,
        prRef,
        previousPrRef,
        rebind: previousPrRef !== null,
        sessionId: ctx.sessionId,
      },
      'link_run_to_pr: bound run to PR/MR',
    );

    // Team mode: push the updated run to cloud so cross-member history
    // sees the link. Solo mode has no cloud; skip. Mirrors
    // link_run_to_issue's enqueue-after-write.
    if (process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(deps.db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'runs', lookup: { kind: 'id', value: input.runId } },
        });
      } catch (err) {
        handlerLogger.warn(
          {
            event: 'link_run_to_pr_sync_enqueue_failed',
            runId: input.runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'sync_to_cloud enqueue threw after prRef update — run will not reach cloud until the next runs push',
        );
      }
    }

    return { ok: true, runId: input.runId, prRef, previousPrRef, updated: true };
  };
}
