import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { DispatchHookEvent, HookDispatchResult } from '../app.js';

/**
 * `apps/hooks-bridge/src/lib/dispatch` — composes the per-phase
 * handlers into a single `DispatchHookEvent` callback the Hono routes
 * pass to.
 *
 * Routing rules:
 *   - `eventPhase === 'pre'`           → preToolUseHandler (real policy eval).
 *   - `eventPhase === 'post'`          → postToolUseHandler (RunRecorder).
 *   - `eventPhase === 'session_start'` → sessionStartHandler (Feature Pack inject).
 *   - `eventPhase === 'session_end'`   → sessionEndHandler (auto-Context-Pack save + close runs).
 *   - `eventPhase === 'turn_end'`      → ack-only. Phase 3 Fix A
 *     (2026-05-02): Claude Code's Stop event lands here so the
 *     auto-Context-Pack save no longer fires N times per session.
 *     If/when per-turn telemetry gains a consumer, attach a handler
 *     in ComposeDispatchDeps and route here.
 *   - `eventPhase === 'user_prompt'`   → userPromptSubmitHandler.
 *
 * Returns null events (Windsurf unmapped) are surfaced from the route
 * directly, not through here. This composer assumes a non-null event.
 */

const dispatchLogger = createLogger('hooks-bridge.dispatch');

export interface ComposeDispatchDeps {
  /** Pre-tool policy handler (S7). */
  readonly preToolUse: (event: HookEvent) => Promise<HookDispatchResult>;
  /** Post-tool RunRecorder handler (S8). */
  readonly postToolUse: (event: HookEvent) => Promise<HookDispatchResult>;
  /** SessionStart handler (S9). */
  readonly sessionStart: (event: HookEvent) => Promise<HookDispatchResult>;
  /** SessionEnd handler — auto-Context-Pack + close runs row (S9 + Pattern 20). */
  readonly sessionEnd: (event: HookEvent) => Promise<HookDispatchResult>;
  /** UserPromptSubmit handler (S10). */
  readonly userPromptSubmit: (event: HookEvent) => Promise<HookDispatchResult>;
}

export function composeDispatch(deps: ComposeDispatchDeps): DispatchHookEvent {
  return async function dispatch(event) {
    if (event === null) {
      // Routes handle null events directly; this is a defensive return.
      return { permissionDecision: 'allow', permissionDecisionReason: 'null_event' };
    }
    if (event.eventPhase === 'pre') {
      return deps.preToolUse(event);
    }
    if (event.eventPhase === 'post') {
      return deps.postToolUse(event);
    }
    if (event.eventPhase === 'session_start') {
      return deps.sessionStart(event);
    }
    if (event.eventPhase === 'session_end') {
      return deps.sessionEnd(event);
    }
    if (event.eventPhase === 'turn_end') {
      // Phase 3 Fix A (2026-05-02): per-turn end. Plain ack — no
      // saveAutoContextPack, no run_event today. See event.ts docblock.
      return { permissionDecision: 'allow' };
    }
    if (event.eventPhase === 'user_prompt') {
      return deps.userPromptSubmit(event);
    }
    // Should never reach here — every HookEvent.eventPhase is covered.
    dispatchLogger.warn(
      {
        event: 'dispatch_unknown_phase',
        sessionId: event.sessionId,
        eventPhase: event.eventPhase,
        agentType: event.agentType,
      },
      'unknown event phase; allowing as a defensive fail-open',
    );
    return { permissionDecision: 'allow' };
  };
}
