import { type DbHandle, postgresSchema, scheduleDurableWrite, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import type { LinkRunToIssueInput, LinkRunToIssueOutput } from './schema.js';

/**
 * Handler factory for `coodra__link_run_to_issue` (§24.4, Module 09
 * Track 9A, ADR-016).
 *
 * Factory shape (not a bare static) because the handler closes over a
 * `DbHandle` for the `runs` SELECT + UPDATE. It does NOT route through
 * `ctx.runRecorder` — this is a direct metadata update on the run row,
 * the same lightweight pattern `get_run_id` uses to write the row in the
 * first place (no auth gate: `issueRef` is run infrastructure scoped by an
 * unguessable `runId`, not attributed authorship like a decision).
 *
 * Flow:
 *   1. SELECT runs(id, issue_ref) for `input.runId`. Missing → structured
 *      `{ ok: false, error: 'run_not_found', howToFix }` soft-failure per
 *      §9.1.2 (mirrors record_decision).
 *   2. Normalise the Jira key to uppercase (`proj-123` → `PROJ-123`).
 *   3. If the run is already bound to that exact key → idempotent no-op
 *      (`updated: false`, no write).
 *   4. Else UPDATE runs SET issue_ref = key WHERE id = runId.
 *   5. Team mode: enqueue a `sync_to_cloud` job for the runs row (by id)
 *      so cross-member history sees the link. Solo mode skips (no cloud).
 *
 * No Jira API call ever happens here — the tool records a local link only.
 * The agent verifies the issue exists via Rovo's `getJiraIssue` if needed.
 */

const handlerLogger = createLogger('mcp-server.tool.link_run_to_issue');

export interface LinkRunToIssueHandlerDeps {
  readonly db: DbHandle;
}

/** SELECT the run's id + current issue_ref, or null when no such run. */
async function selectRun(
  db: DbHandle,
  runId: string,
): Promise<{ readonly id: string; readonly issueRef: string | null } | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.runs.id, issueRef: sqliteSchema.runs.issueRef })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.id, runId))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.runs.id, issueRef: postgresSchema.runs.issueRef })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/** UPDATE runs.issue_ref for the given run id (both dialects). */
async function updateIssueRef(db: DbHandle, runId: string, issueRef: string): Promise<void> {
  if (db.kind === 'sqlite') {
    await db.db.update(sqliteSchema.runs).set({ issueRef }).where(eq(sqliteSchema.runs.id, runId));
    return;
  }
  await db.db.update(postgresSchema.runs).set({ issueRef }).where(eq(postgresSchema.runs.id, runId));
}

export function createLinkRunToIssueHandler(deps: LinkRunToIssueHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createLinkRunToIssueHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createLinkRunToIssueHandler: deps.db must be a DbHandle');
  }

  return async function linkRunToIssueHandler(
    input: LinkRunToIssueInput,
    ctx: ToolContext,
  ): Promise<LinkRunToIssueOutput> {
    // Tracker issue keys are conventionally uppercase (Jira, Linear, ...);
    // normalise so the stored key is canonical regardless of how the agent
    // typed it. Harmless no-op for references that aren't case-shaped.
    const issueRef = input.issueRef.toUpperCase();

    const run = await selectRun(deps.db, input.runId);
    if (run === null) {
      handlerLogger.info(
        { event: 'link_run_to_issue_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'link_run_to_issue: runId does not match a runs row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix:
          'Call get_run_id first to obtain a runId for this session, then retry link_run_to_issue with that runId.',
      };
    }

    const previousIssueRef = run.issueRef;

    // Idempotent: already bound to this exact key → no write.
    if (previousIssueRef === issueRef) {
      handlerLogger.info(
        { event: 'link_run_to_issue_unchanged', runId: input.runId, issueRef, sessionId: ctx.sessionId },
        'link_run_to_issue: run already bound to this issue — no-op',
      );
      return { ok: true, runId: input.runId, issueRef, previousIssueRef, updated: false };
    }

    await updateIssueRef(deps.db, input.runId, issueRef);
    handlerLogger.info(
      {
        event: 'link_run_to_issue_updated',
        runId: input.runId,
        issueRef,
        previousIssueRef,
        rebind: previousIssueRef !== null,
        sessionId: ctx.sessionId,
      },
      'link_run_to_issue: bound run to Jira issue',
    );

    // Team mode: push the updated run to cloud so cross-member history
    // ("what touched PROJ-412?") sees the link. The daemon SELECTs the
    // canonical runs row by id at dispatch and upserts it. Solo mode has
    // no cloud; skip. Mirrors record_decision's enqueue-after-write.
    if (process.env.COODRA_MODE === 'team') {
      try {
        await scheduleDurableWrite(deps.db, {
          queue: 'sync_to_cloud',
          payload: { v: 1 as const, table: 'runs', lookup: { kind: 'id', value: input.runId } },
        });
      } catch (err) {
        handlerLogger.warn(
          {
            event: 'link_run_to_issue_sync_enqueue_failed',
            runId: input.runId,
            err: err instanceof Error ? err.message : String(err),
          },
          'sync_to_cloud enqueue threw after issueRef update — run will not reach cloud until the next runs push',
        );
      }
    }

    return { ok: true, runId: input.runId, issueRef, previousIssueRef, updated: true };
  };
}
