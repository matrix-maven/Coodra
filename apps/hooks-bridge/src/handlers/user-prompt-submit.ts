import type { DbHandle } from '@coodra/db';
import { createLogger, parseJiraWorkIntent, renderJiraWorkModeContext } from '@coodra/shared';
import type { HookEvent } from '@coodra/shared/hooks';
import { readCoodraProjectConfig } from '@coodra/shared/project-config';
import { renderWorkflowPolicyContext } from '@coodra/shared/workflow-policy';

import type { HookDispatchResult } from '../app.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

/**
 * `apps/hooks-bridge/src/handlers/user-prompt-submit` — schedules an
 * audit append to `run_events` with `phase = 'user_prompt'`.
 *
 * Both Claude Code's and Codex's `UserPromptSubmit` events surface
 * here (each adapter folds `prompt` + `prompt_id` into the event's
 * `toolInput` field with stable sentinel `toolName: 'user_prompt'`).
 * A future agent adapter mapping to the same eventPhase is picked up
 * without modification.
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
    const intent = parseJiraWorkIntent(event.toolInput);
    let workflowPolicyBlock: string | null = null;
    if (intent !== null) {
      try {
        const cfg = await readCoodraProjectConfig(event.cwd);
        workflowPolicyBlock =
          cfg !== null
            ? renderWorkflowPolicyContext(cfg.workflowPolicy, {
                projectSlug: cfg.projectSlug,
                includeTitle: true,
              })
            : null;
      } catch {
        workflowPolicyBlock = null;
      }
    }
    const additionalContext =
      intent !== null
        ? [renderJiraWorkModeContext(intent), workflowPolicyBlock]
            .filter((block): block is string => block !== null)
            .join('\n\n---\n\n')
        : undefined;
    userPromptLogger.info(
      {
        event: 'user_prompt_recorded',
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(intent !== null ? { workPackSlug: intent.slug, jiraIssueKey: intent.issueKey } : {}),
      },
      'UserPromptSubmit audit scheduled',
    );
    return { permissionDecision: 'allow', ...(additionalContext !== undefined ? { additionalContext } : {}) };
  };
}
