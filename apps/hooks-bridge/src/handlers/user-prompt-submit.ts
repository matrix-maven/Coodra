import type { DbHandle } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { HookDispatchResult } from '../app.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

/**
 * `apps/hooks-bridge/src/handlers/user-prompt-submit` — schedules an
 * audit append to `run_events` with `phase = 'user_prompt'`.
 *
 * Today only Claude Code's `UserPromptSubmit` event surfaces here
 * (the adapter folds `prompt` + `prompt_id` into the event's
 * `toolInput` field with stable sentinel `toolName: 'user_prompt'`).
 * Windsurf's `pre_user_prompt` and Cursor's potential equivalent map
 * to the same eventPhase via the per-agent adapters; if those land
 * later, this handler picks them up without modification.
 *
 * The recorder clamps `toolInput` to 8KB code points, so a multi-MB
 * paste is safely truncated rather than dropped.
 *
 * Resolves projectId from `event.cwd` so the recorder can populate
 * `run_events.run_id` (verification F8 closure, 2026-04-27).
 */

const userPromptLogger = createLogger('hooks-bridge.user-prompt-submit');

export interface CreateUserPromptSubmitHandlerDeps {
  readonly runRecorder: RunRecorder;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
}

export type UserPromptSubmitHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createUserPromptSubmitHandler(deps: CreateUserPromptSubmitHandlerDeps): UserPromptSubmitHandler {
  return async function handleUserPromptSubmit(event) {
    if (event.eventPhase !== 'user_prompt') {
      userPromptLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'user-prompt-submit handler called for non-user_prompt event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }
    // M04 Phase 2 S1 (F3 root-cause fix): resolveAndEnsure so the
    // user_prompt run_event row lands with a real run_id FK.
    const { projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);
    deps.runRecorder.recordUserPromptSubmit(event, projectId);
    userPromptLogger.info(
      {
        event: 'user_prompt_recorded',
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(projectId !== undefined ? { projectId } : {}),
      },
      'UserPromptSubmit audit scheduled',
    );
    return { permissionDecision: 'allow' };
  };
}
