import { attestPolicyProjection, type DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import type { HookEvent } from '@coodra/shared/hooks';

import type { HookDispatchResult } from '../app.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';

const configChangeLogger = createLogger('hooks-bridge.config-change');

export interface CreateConfigChangeHandlerDeps {
  readonly db: DbHandle;
  readonly projectSlugResolver: ProjectSlugResolver;
}

export type ConfigChangeHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createConfigChangeHandler(deps: CreateConfigChangeHandlerDeps): ConfigChangeHandler {
  return async function handleConfigChange(event) {
    if (event.eventPhase !== 'config_change') {
      configChangeLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'config-change handler called for non-config_change event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }

    const { slug, projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);
    const projectSlug = typeof slug === 'string' && slug.length > 0 ? slug : null;
    const projectRoot = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : null;
    if (typeof projectId !== 'string' || projectRoot === null) {
      return { permissionDecision: 'allow', permissionDecisionReason: 'config_change_no_project' };
    }

    try {
      const attestation = await attestPolicyProjection(deps.db, {
        projectId,
        projectSlug,
        projectRoot,
        agentType: event.agentType,
        sessionId: event.sessionId,
      });
      configChangeLogger.info(
        {
          event: 'config_change_policy_projection_attested',
          sessionId: event.sessionId,
          projectId,
          projectSlug,
          agentType: event.agentType,
          status: attestation.status,
          eventId: attestation.eventId,
        },
        'ConfigChange policy projection attestation complete',
      );
    } catch (err) {
      configChangeLogger.warn(
        {
          event: 'config_change_policy_projection_attestation_failed',
          sessionId: event.sessionId,
          projectId,
          projectSlug,
          agentType: event.agentType,
          err: err instanceof Error ? err.message : String(err),
        },
        'policy projection attestation threw on ConfigChange; allowing',
      );
    }

    return { permissionDecision: 'allow' };
  };
}
