import { type DbHandle, GLOBAL_PROJECT_ID, lookupRunId } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { HookDispatchResult } from '../app.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

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
    postToolLogger.info(
      {
        event: 'post_tool_use_recorded',
        sessionId: event.sessionId,
        toolName: event.toolName,
        agentType: event.agentType,
        turnId: event.turnId,
        ...(projectId !== undefined ? { projectId } : {}),
        runId: runId ?? 'unresolved',
      },
      'post-tool-use audit scheduled',
    );
    return { permissionDecision: 'allow' };
  };
}
