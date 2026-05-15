import { type DbHandle, GLOBAL_PROJECT_ID, lookupRunId, sqliteSchema } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import type { HookEvent } from '@coodra/shared/hooks';
import { and, eq } from 'drizzle-orm';

import type { HookDispatchResult } from '../app.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';
import { markSaveContextPackCalled, recordPostToolUseAndCheckReminder } from '../lib/session-state.js';

/**
 * Module 05 §6.D — mid-session reminder threshold.
 *
 * After this many PostToolUse events for one run without a
 * `save_context_pack` call, the bridge injects a one-shot
 * `<system-reminder>` via the response's `additionalContext`. Tuned
 * empirically: 15 is a "long" session in current Coodra usage,
 * short enough sessions (<15 tools) get no nag.
 *
 * Future: per-project override via `.coodra.json:sessionStart.midSessionReminderAfter`.
 */
const M05_MID_SESSION_REMINDER_THRESHOLD = 15;

const M05_MID_SESSION_REMINDER = [
  '<system-reminder>',
  "You've made a number of tool calls in this session without calling save_context_pack.",
  'When you wrap up this work, call it with a narrative recap of what was built — that',
  'is the canonical record the next session reads. Otherwise the bridge will write only',
  'a structured event digest as a fallback.',
  '</system-reminder>',
].join('\n');

/**
 * `apps/hooks-bridge/src/handlers/post-tool-use` — schedules the audit
 * write to `run_events` and returns allow synchronously. Per
 * `system-architecture.md` §8 the response budget is p95 < 10ms; we
 * never await the DB write.
 *
 * Resolves projectId from `event.cwd` so the recorder can populate
 * `run_events.run_id` (verification F8 closure, 2026-04-27). The pre-
 * tool handler already does the same resolve; we mirror it here so
 * post-tool audit rows aren't orphaned.
 */

const postToolLogger = createLogger('hooks-bridge.post-tool-use');

export interface CreatePostToolUseHandlerDeps {
  readonly runRecorder: RunRecorder;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
}

export type PostToolUseHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createPostToolUseHandler(deps: CreatePostToolUseHandlerDeps): PostToolUseHandler {
  return async function handlePostToolUse(event) {
    if (event.eventPhase !== 'post') {
      postToolLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'post-tool-use handler called for non-post event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }
    // M04 Phase 2 S1 (F3 root-cause fix): resolveAndEnsure so the
    // run_event row lands with a real run_id FK (the synthetic run is
    // created at SessionStart-or-PreToolUse time; this call is the
    // safety net for the SessionStart-missed path).
    const { projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);
    deps.runRecorder.recordPostToolUse(event, projectId);
    // F15 closure (2026-04-27): include runId in the INFO log line so
    // SOC2 / NHI auditors can grep for a single runId across bridge +
    // MCP service streams. Sync lookup costs ~1ms on the hot path.
    const lookupProjectId = projectId ?? GLOBAL_PROJECT_ID;
    let runId: string | null = null;
    try {
      runId = await lookupRunId(deps.db, lookupProjectId, event.sessionId);
    } catch (err) {
      postToolLogger.warn(
        {
          event: 'post_tool_use_run_id_lookup_failed',
          sessionId: event.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'lookupRunId threw; logging without runId',
      );
    }
    // M05 §6.D — mid-session reminder. If we have a runId AND the
    // PostToolUse counter has crossed the threshold AND the agent has
    // not already saved a context pack, inject a one-shot reminder
    // via additionalContext. Idempotent per run (the counter sets a
    // flag after the first fire).
    //
    // Cross-process flag sync: MCP and bridge are separate processes,
    // so we can't share an in-memory map. When the in-memory counter
    // crosses the threshold we do a single DB lookup against
    // `context_packs(run_id)` — if an agent-authored row already
    // exists, mark the counter as compliant and skip the reminder.
    // The DB hit happens at most once per run.
    let reminderInjected = false;
    if (runId !== null) {
      const wouldFire = recordPostToolUseAndCheckReminder(runId, M05_MID_SESSION_REMINDER_THRESHOLD);
      if (wouldFire) {
        try {
          if (deps.db.kind === 'sqlite') {
            const cp = sqliteSchema.contextPacks;
            const existing = (await deps.db.db
              .select({ id: cp.id, source: cp.source })
              .from(cp)
              .where(and(eq(cp.runId, runId), eq(cp.source, 'agent')))
              .limit(1)) as Array<{ id: string; source: string }>;
            if (existing[0] !== undefined) {
              // Agent already saved — never nag.
              markSaveContextPackCalled(runId);
            } else {
              reminderInjected = true;
            }
          } else {
            reminderInjected = true;
          }
        } catch (err) {
          postToolLogger.warn(
            {
              event: 'post_tool_use_save_pack_lookup_failed',
              sessionId: event.sessionId,
              runId,
              err: err instanceof Error ? err.message : String(err),
            },
            'm05 reminder lookup threw; firing reminder anyway (fail-safe-loud)',
          );
          reminderInjected = true;
        }
      }
    }

    postToolLogger.info(
      {
        event: 'post_tool_use_recorded',
        sessionId: event.sessionId,
        toolName: event.toolName,
        agentType: event.agentType,
        turnId: event.turnId,
        ...(projectId !== undefined ? { projectId } : {}),
        runId: runId ?? 'unresolved',
        ...(reminderInjected ? { m05ReminderFired: true } : {}),
      },
      'post-tool-use audit scheduled',
    );
    if (reminderInjected) {
      return { permissionDecision: 'allow', additionalContext: M05_MID_SESSION_REMINDER };
    }
    return { permissionDecision: 'allow' };
  };
}
