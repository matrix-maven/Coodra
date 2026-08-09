import { type DbHandle, lookupProjectById, markRunCompleted } from '@coodra/db';
import { resolveAskOutcomesNotExecuted } from '@coodra/policy';
import { createLogger } from '@coodra/shared';

import { saveAutoContextPack } from './auto-context-pack.js';
import { runRunDiff } from './run-diff-runner.js';
import { updateLinkedWorkPackFromRun } from './work-pack-session-update.js';

/**
 * `packages/lifecycle/src/finalize-run-on-session-end.ts`
 *
 * Agent-transport-agnostic SessionEnd finalization, extracted from
 * `apps/hooks-bridge/src/handlers/session-end.ts`'s
 * `scheduleAutoContextPackSave` (2026-08-08, Phase 1 of the
 * hooks-bridge-retirement plan). Both the HTTP Hooks Bridge (Claude
 * Code only, legacy transport) and the native `lifecycle_event` MCP
 * tool (Codex/Devin/Cursor/Antigravity/Claude Code plugin installs)
 * call this so a SessionEnd produces the same artifacts regardless of
 * which transport delivered the hook: run-diff capture, run
 * completion, an auto-saved Context Pack, a synced linked Work Pack,
 * and a sweep of any `ask` policy decisions the agent never actually
 * executed.
 *
 * Callers resolve `runId` (and `sessionId`/`cwd`/`projectId`/
 * `createdByUserId`) themselves before calling this — this function
 * does not look up a run by session, and does not resolve actor
 * identity. The native `lifecycle_event` handler already has `runId`
 * resolved via `resolveRunId`; the bridge resolves it via
 * `lookupRunId(db, projectId, sessionId)` before calling in.
 *
 * SQLite-only limitation: `runRunDiff`, `saveAutoContextPack`, and
 * `updateLinkedWorkPackFromRun` are each independently guarded
 * (`db.kind !== 'sqlite'` → no-op/null) inside their own
 * implementations — this matches the pre-extraction bridge behavior,
 * which never supported postgres/team-mode for these three steps.
 * `markRunCompleted` and the ask-outcome sweep are dialect-agnostic
 * and run for both. This finalizer does not change that split; it
 * only centralizes the orchestration.
 *
 * Callers that cannot tolerate blocking (e.g. an HTTP handler with a
 * response-latency budget) should call this without awaiting it and
 * let it run in the background, same as the bridge's pre-extraction
 * `void scheduleAutoContextPackSave(...)`. Callers backed by a
 * short-lived subprocess (`hook-runner.mjs`, one process per hook
 * call) MUST await it — there is no persistent process left to finish
 * the work after the hook response is sent.
 */

const logger = createLogger('lifecycle.finalize-run-on-session-end');

export interface FinalizeRunOnSessionEndInput {
  readonly db: DbHandle;
  readonly runId: string;
  /**
   * Working directory for the run-diff git plumbing. When absent (COOD-60
   * — some transports fire SessionEnd without a cwd on the event
   * payload), falls back to the registered `projects.cwd` for `projectId`
   * before giving up. Diff capture is skipped only if neither is available.
   */
  readonly cwd?: string;
  /** Pre-resolved actor identity (team mode) to stamp on the auto-saved Context Pack. Not resolved here. */
  readonly createdByUserId?: string | null;
  /** Pre-resolved project id. Auto Context Pack save + linked Work Pack update are skipped when absent. */
  readonly projectId?: string;
  /** Overrides the on-disk root for the auto-saved pack's `.md` file. Tests pass a tmpdir; production omits it and gets `defaultContextPacksRoot()`. */
  readonly contextPacksRoot?: string;
  /** For log context only — no agent-specific branching. */
  readonly agentType?: string;
  /** Session id for the unexecuted-`ask`-outcome sweep. Sweep is skipped when absent. */
  readonly sessionId?: string;
  readonly now?: Date;
}

export interface FinalizeRunOnSessionEndResult {
  readonly runId: string;
  readonly ranRunDiff: boolean;
  readonly savedAutoContextPack: boolean;
  readonly updatedLinkedWorkPack: boolean;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function finalizeRunOnSessionEnd(
  input: FinalizeRunOnSessionEndInput,
): Promise<FinalizeRunOnSessionEndResult> {
  const now = input.now ?? new Date();
  const logCtx = { runId: input.runId, agentType: input.agentType };

  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    await resolveAskOutcomesNotExecuted(input.db, { sessionId: input.sessionId, now }).catch((err) => {
      logger.warn(
        { event: 'finalize_ask_outcome_sweep_failed', ...logCtx, sessionId: input.sessionId, err: errMessage(err) },
        'failed to resolve unexecuted ask outcomes on SessionEnd',
      );
    });
  }

  let runDiffCwd = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : null;
  let runDiffCwdSource: 'event' | 'project_fallback' = 'event';
  if (runDiffCwd === null && input.projectId !== undefined) {
    try {
      const project = await lookupProjectById(input.db, input.projectId);
      if (project?.cwd !== null && project?.cwd !== undefined && project.cwd.length > 0) {
        runDiffCwd = project.cwd;
        runDiffCwdSource = 'project_fallback';
      }
    } catch (err) {
      logger.warn(
        { event: 'finalize_run_diff_cwd_fallback_failed', ...logCtx, projectId: input.projectId, err: errMessage(err) },
        'projects.cwd fallback lookup threw; proceeding without a run-diff cwd',
      );
    }
  }

  let ranRunDiff = false;
  if (runDiffCwd !== null) {
    if (runDiffCwdSource === 'project_fallback') {
      logger.info(
        { event: 'finalize_run_diff_cwd_fallback_used', ...logCtx, projectId: input.projectId },
        'SessionEnd event carried no cwd; falling back to projects.cwd for run-diff capture',
      );
    }
    try {
      await runRunDiff({ db: input.db, runId: input.runId, cwd: runDiffCwd });
      ranRunDiff = true;
    } catch (err) {
      logger.warn(
        { event: 'finalize_run_diff_threw', ...logCtx, err: errMessage(err) },
        'run-diff runner threw; auto-pack save will proceed without a diff section',
      );
    }
  } else {
    logger.info(
      { event: 'finalize_run_diff_skipped', reason: 'no_cwd', ...logCtx },
      'run-diff runner skipped: no cwd on event and no projects.cwd fallback available',
    );
  }

  // Mark the run completed before the auto-pack save (matches the
  // bridge's pre-extraction ordering — see that handler's inline
  // comment for why: a healthy SessionEnd must not leave a run to be
  // caught by the stale-runs sweeper as 'cancelled').
  await markRunCompleted(input.db, input.runId, now);

  let savedAutoContextPack = false;
  let updatedLinkedWorkPack = false;
  if (input.projectId !== undefined) {
    try {
      const result = await saveAutoContextPack({
        runId: input.runId,
        projectId: input.projectId,
        db: input.db,
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
        ...(input.contextPacksRoot !== undefined ? { contextPacksRoot: input.contextPacksRoot } : {}),
      });
      savedAutoContextPack = result !== null;
      await updateLinkedWorkPackFromRun({ db: input.db, runId: input.runId, now });
      updatedLinkedWorkPack = true;
    } catch (err) {
      logger.warn(
        { event: 'finalize_auto_pack_save_failed', ...logCtx, err: errMessage(err) },
        'auto-save Context Pack / linked Work Pack update failed; run completion is unaffected',
      );
    }
  } else {
    logger.info(
      { event: 'finalize_auto_pack_skipped', reason: 'no_project_id', ...logCtx },
      'auto-save Context Pack skipped: no project resolved',
    );
  }

  return { runId: input.runId, ranRunDiff, savedAutoContextPack, updatedLinkedWorkPack };
}
