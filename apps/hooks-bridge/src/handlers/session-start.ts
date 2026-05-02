import type { DbHandle } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { HookDispatchResult } from '../app.js';
import { loadFeaturePackForSession } from '../lib/feature-pack-loader.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

/**
 * `apps/hooks-bridge/src/handlers/session-start` — opens the `runs`
 * row AND injects the project-level Feature Pack into the agent's
 * turn-zero context via Claude Code's `additionalContext` field.
 *
 * Decision dec_83ba10c1 (2026-05-02 — Bridge-mediated autonomous
 * coordination defaults, system-architecture §16 Pattern 20). Pre-
 * decision the SessionStart handler returned only `permissionDecision:
 * 'allow'` and the agent had to remember to call `contextos__
 * get_feature_pack` itself. With this change, every Claude Code
 * SessionStart hook ships the pack body inline — no agent action
 * required.
 *
 * Failure modes (all return allow + log):
 *   - projectSlug not resolved (no `.contextos.json` in cwd) → no
 *     additionalContext, log `session_start_no_project_slug`.
 *   - Feature Pack files absent on disk → no additionalContext, log
 *     `session_start_pack_not_found`. Agents fall through to the
 *     §24 MCP tool path if they need it mid-session.
 *
 * Audit (run_events / runs row) is fire-and-forget per §16 pattern
 * 3 outbox. Pack injection is awaited because the response shape
 * carries it; latency is bounded by the three Promise.all reads
 * against `<cwd>/docs/feature-packs/<slug>/*.md` (~1ms typical).
 */

const sessionStartLogger = createLogger('hooks-bridge.session-start');

export interface CreateSessionStartHandlerDeps {
  readonly runRecorder: RunRecorder;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
  readonly mode: 'solo' | 'team';
}

export type SessionStartHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createSessionStartHandler(deps: CreateSessionStartHandlerDeps): SessionStartHandler {
  return async function handleSessionStart(event) {
    if (event.eventPhase !== 'session_start') {
      sessionStartLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'session-start handler called for non-session_start event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }
    const { slug, projectId } = await deps.projectSlugResolver.resolve(event.cwd, deps.db);
    deps.runRecorder.recordSessionStart({ event, projectId, mode: deps.mode });

    let additionalContext: string | undefined;
    const slugValue = typeof slug === 'string' && slug.length > 0 ? slug : null;
    const cwdValue = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : null;
    if (slugValue !== null && cwdValue !== null) {
      const projectSlug: string = slugValue;
      const cwd: string = cwdValue;
      try {
        const loaded = await loadFeaturePackForSession({ cwd, projectSlug });
        if (loaded !== null) {
          additionalContext = loaded.content;
        }
      } catch (err) {
        sessionStartLogger.warn(
          {
            event: 'session_start_feature_pack_load_failed',
            sessionId: event.sessionId,
            projectSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          'feature-pack load threw; SessionStart proceeding without additionalContext',
        );
      }
    } else {
      sessionStartLogger.info(
        { event: 'session_start_no_project_slug', sessionId: event.sessionId, cwd: event.cwd },
        'no project slug for cwd; SessionStart proceeding without additionalContext',
      );
    }

    sessionStartLogger.info(
      {
        event: 'session_start_recorded',
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(slug !== undefined ? { projectSlug: slug } : {}),
        additionalContextBytes: typeof additionalContext === 'string' ? additionalContext.length : 0,
      },
      'SessionStart audit scheduled',
    );

    if (typeof additionalContext === 'string') {
      return { permissionDecision: 'allow', additionalContext };
    }
    return { permissionDecision: 'allow' };
  };
}
