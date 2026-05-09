import { type DbHandle, lookupRunId, sqliteSchema } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { HookDispatchResult } from '../app.js';
import { saveAutoContextPack } from '../lib/auto-context-pack.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';
import { clearSessionState } from '../lib/session-state.js';

/**
 * `apps/hooks-bridge/src/handlers/session-end` — closes the `runs`
 * row AND auto-saves a structured Context Pack for the run if the
 * agent did not call `save_context_pack` itself.
 *
 * Decision dec_83ba10c1 (2026-05-02 — system-architecture §16
 * Pattern 20). Pre-decision the SessionEnd handler only closed the
 * `runs` row; if the agent forgot `save_context_pack`, the run
 * left no permanent record. Now every Claude Code session produces
 * a Context Pack at SessionEnd via the bridge — even when the
 * agent forgets — and the agent's mid-session call (if any) is
 * preserved unchanged via the append-only ADR-007 semantics.
 *
 * **Phase 3 Fix A (2026-05-02 — `dec_ea32e7ed`):** trigger source
 * corrected. Pre-Phase-3 the auto-save fired on Claude Code's `Stop`
 * event (per-turn end, N firings per session — deduped but wasted
 * work). Phase 3 verification confirmed Claude Code emits a distinct
 * `SessionEnd` event for session-termination (matcher reasons:
 * `clear` / `resume` / `logout` / `prompt_input_exit` /
 * `bypass_permissions_disabled` / `other`). The adapter now maps
 * `SessionEnd → eventPhase 'session_end'` and `Stop → eventPhase
 * 'turn_end'`; this handler fires only for the former. The unique
 * `context_packs.run_id` index remains as defense-in-depth, but the
 * common-case dedupe burden is gone.
 *
 * Failure-mode discipline: the auto-save runs **without being
 * awaited** in the response path. The hook returns
 * `{ permissionDecision: 'allow' }` synchronously inside the
 * §6 / §16-pattern-3 latency budget; the DB write runs to
 * completion in the background. Errors are logged and swallowed —
 * an auto-save failure must never block session shutdown.
 *
 * Idempotency: `context_packs.run_id` is uniquely indexed; a
 * replayed SessionEnd event triggers `saveAutoContextPack`'s
 * select-first-then-insert path, which returns the existing row
 * with `created: false`. Replaying the event is a no-op.
 *
 * Skipped when:
 *   - projectId is undefined (no `.contextos.json` in cwd) — the
 *     `__global__` sentinel project is not a sensible target for
 *     a per-run Context Pack.
 *   - lookupRunId returns null (SessionStart never fired or the
 *     `runs` row was rolled back).
 */

const sessionEndLogger = createLogger('hooks-bridge.session-end');

export interface CreateSessionEndHandlerDeps {
  readonly runRecorder: RunRecorder;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
}

export type SessionEndHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createSessionEndHandler(deps: CreateSessionEndHandlerDeps): SessionEndHandler {
  return async function handleSessionEnd(event) {
    if (event.eventPhase !== 'session_end') {
      sessionEndLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'session-end handler called for non-session_end event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }
    // M04 Phase 2 S1 (F3 root-cause fix): resolveAndEnsure so the
    // session_close UPDATE has a runs row to target (defensive — if
    // SessionStart was somehow missed, this still closes the loop).
    const { projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);
    deps.runRecorder.recordSessionEnd({ event, projectId });
    sessionEndLogger.info(
      {
        event: 'session_end_recorded',
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(projectId !== undefined ? { projectId } : {}),
      },
      'SessionEnd audit scheduled',
    );

    // Auto-save the Context Pack in the background — fire-and-forget
    // so the hook responds within the §6 latency budget. Errors are
    // logged and swallowed.
    void scheduleAutoContextPackSave({
      sessionId: event.sessionId,
      projectId,
      db: deps.db,
    });

    return { permissionDecision: 'allow' };
  };
}

async function scheduleAutoContextPackSave(args: {
  readonly sessionId: string;
  readonly projectId: string | undefined;
  readonly db: DbHandle;
}): Promise<void> {
  if (args.projectId === undefined) {
    sessionEndLogger.info(
      { event: 'session_end_auto_pack_skipped', reason: 'no_project_id', sessionId: args.sessionId },
      'auto-save Context Pack skipped: no project resolved for cwd',
    );
    return;
  }
  let runId: string | null = null;
  try {
    runId = await lookupRunId(args.db, args.projectId, args.sessionId);
  } catch (err) {
    sessionEndLogger.warn(
      {
        event: 'session_end_auto_pack_lookup_failed',
        sessionId: args.sessionId,
        err: err instanceof Error ? err.message : String(err),
      },
      'auto-save Context Pack skipped: lookupRunId threw',
    );
    return;
  }
  if (runId === null) {
    sessionEndLogger.info(
      { event: 'session_end_auto_pack_skipped', reason: 'no_run_id', sessionId: args.sessionId },
      'auto-save Context Pack skipped: SessionStart did not register a runs row',
    );
    return;
  }
  // M05 §6.D — drop the per-run mid-session counter. Idempotent on
  // unknown runId. Done before the auto-save so the counter can't
  // outlive the run even if the auto-save throws.
  clearSessionState(runId);
  // 2026-05-08 fix: mark the run completed BEFORE attempting the
  // auto-pack save. Pre-fix, runs.status was only flipped to 'completed'
  // by `save_context_pack` MCP (handler.ts → markRunCompleted). When the
  // agent never called the MCP tool, the run sat as in_progress until
  // the 30-min stale-runs sweeper cancelled it as 'cancelled' — wrong
  // terminal status for a healthy SessionEnd. The status flip is the
  // bridge's responsibility on every SessionEnd that resolves to a real
  // runId, regardless of whether the agent or the bridge writes the
  // pack. Idempotent: WHERE status='in_progress' so a re-played
  // SessionEnd does nothing on the second pass.
  try {
    await markRunCompletedOnSessionEnd(args.db, runId);
  } catch (err) {
    sessionEndLogger.warn(
      {
        event: 'session_end_run_status_flip_failed',
        sessionId: args.sessionId,
        runId,
        err: err instanceof Error ? err.message : String(err),
      },
      'failed to flip runs.status to completed; the auto-pack save will still run, sweeper catches the row eventually',
    );
  }
  try {
    await saveAutoContextPack({ runId, projectId: args.projectId, db: args.db });
  } catch (err) {
    sessionEndLogger.warn(
      {
        event: 'session_end_auto_pack_save_failed',
        sessionId: args.sessionId,
        runId,
        err: err instanceof Error ? err.message : String(err),
      },
      'auto-save Context Pack failed; session is closed regardless',
    );
  }
}

/**
 * Mark the run completed on SessionEnd. Idempotent — only flips rows
 * that are still `in_progress`, so a re-played SessionEnd is a no-op.
 *
 * v1 supports SQLite only (matching the rest of the bridge). The
 * `endedAt` column is `integer mode:'timestamp'` so we use raw
 * `unixepoch()` to align with the DEFAULT clause used elsewhere
 * (avoids JS-Date round-trip drift).
 */
async function markRunCompletedOnSessionEnd(db: DbHandle, runId: string): Promise<void> {
  if (db.kind !== 'sqlite') {
    return;
  }
  const t = sqliteSchema.runs;
  await db.db
    .update(t)
    .set({ status: 'completed', endedAt: sql`(unixepoch())` })
    .where(and(eq(t.id, runId), ne(t.status, 'completed')));
}
