import { type DbHandle, GLOBAL_PROJECT_ID, lookupRunId } from '@coodra/contextos-db';
import type { PolicyClient, PolicyInput } from '@coodra/contextos-policy';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { HookDispatchResult } from '../app.js';
import type { KillSwitchEvaluator } from '../lib/kill-switch-evaluator.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

/**
 * `apps/hooks-bridge/src/handlers/pre-tool-use` — pre-tool policy
 * enforcement. Called from `app.ts`'s dispatch path when the
 * normalized event has `eventPhase === 'pre'`.
 *
 * Contract per `system-architecture.md` §7 + §16 pattern 4:
 *
 *   - The only `deny` returned is from a rule that explicitly
 *     matched. Every error path returns `{ permissionDecision:
 *     'allow', permissionDecisionReason: '...' }` with a structured
 *     reason.
 *
 *   - Latency budget: p95 < 50ms in solo mode. The cache + breaker in
 *     `@coodra/contextos-policy::createPolicyClient` is the load-bearing
 *     piece; this handler does not add another layer.
 *
 *   - Audit-write to `policy_decisions` is async (`setImmediate`) and
 *     idempotent (ON CONFLICT DO NOTHING). The dispatcher returns
 *     before the write completes; failure to write is WARN-logged
 *     with full decision context. (S8 lands the audit write — this
 *     slice focuses on the decision path itself.)
 *
 * **Module 08b S2 (2026-05-03) — kill-switch short-circuit.** When a
 * `KillSwitchEvaluator` is wired in (`deps.killSwitchEvaluator`), the
 * handler consults it BEFORE the policy chain on every PreToolUse:
 *
 *   - hard-mode match → return `permissionDecision: 'deny'` + reason
 *     `kill_switch_paused:<id>`. The policy chain is skipped entirely.
 *   - soft-mode match → return `permissionDecision: 'allow'` + the
 *     same reason. The audit row is still recorded (operator wants
 *     observability) but enforcement is bypassed.
 *   - no match → fall through to the existing policy chain unchanged.
 *
 * The evaluator's own DB-throw path returns `null` (fail open), so a
 * kill_switches table outage degrades gracefully into the policy
 * chain. See `apps/hooks-bridge/src/lib/kill-switch-evaluator.ts`
 * for the cache + failure-mode semantics.
 *
 * `eventPhase !== 'pre'` is treated as a contract violation — the
 * dispatcher should only call this handler for pre events. Handler
 * returns allow + reason 'event_phase_mismatch' as a defensive belt-
 * and-suspenders.
 */

const preToolLogger = createLogger('hooks-bridge.pre-tool-use');

export interface CreatePreToolUseHandlerDeps {
  readonly policy: PolicyClient;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
  /** Optional — if provided, the handler schedules a policy_decisions audit-write per call. */
  readonly runRecorder?: RunRecorder;
  /**
   * Optional Module 08b S2 short-circuit. When wired, the handler
   * consults the evaluator BEFORE the policy chain. When omitted
   * (e.g. legacy tests, pre-M08b binaries) the kill-switch step is
   * skipped entirely and only the policy chain runs.
   */
  readonly killSwitchEvaluator?: KillSwitchEvaluator;
}

export type PreToolUseHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createPreToolUseHandler(deps: CreatePreToolUseHandlerDeps): PreToolUseHandler {
  return async function handlePreToolUse(event) {
    if (event.eventPhase !== 'pre') {
      preToolLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'pre-tool-use handler called for non-pre event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }

    // M04 Phase 2 S1 (F3 root-cause fix): resolveAndEnsure auto-creates
    // the projects row when no SessionStart preceded this PreToolUse.
    // Policy evaluation against a brand-new project sees no rules (same
    // as the prior __global__ fallback), so the decision shape is
    // unchanged; the audit row now lands with a real projectId FK.
    const { slug, projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);

    // Module 08b S2 (2026-05-03): kill-switch short-circuit. Consults
    // `kill_switches` BEFORE the policy chain. On match, the handler
    // records the audit row (per the existing recorder contract — same
    // shape as a policy match, with `matchedRuleId: null` and
    // `reason: 'kill_switch_paused:<id>'`) and returns the
    // hard-vs-soft-mode decision. The policy chain is skipped on a
    // match — the operator's pause intent supersedes per-rule policy
    // for the duration of the switch.
    if (deps.killSwitchEvaluator !== undefined) {
      const switchResult = await deps.killSwitchEvaluator.check({
        projectId: projectId ?? null,
        toolName: event.toolName,
        agentType: event.agentType,
      });
      if (switchResult !== null) {
        if (deps.runRecorder !== undefined) {
          deps.runRecorder.recordPolicyDecision({
            event,
            projectId,
            decision: switchResult.decision,
            reason: switchResult.reason,
            matchedRuleId: null,
          });
        }
        preToolLogger.info(
          {
            event: 'pre_tool_use_kill_switch_decision',
            sessionId: event.sessionId,
            toolName: event.toolName,
            agentType: event.agentType,
            killSwitchId: switchResult.matched.id,
            killSwitchScope: switchResult.matched.scope,
            killSwitchTarget: switchResult.matched.target,
            killSwitchMode: switchResult.matched.mode,
            permissionDecision: switchResult.decision,
            ...(slug !== undefined ? { projectSlug: slug } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
          },
          `pre-tool-use kill-switch decision (${switchResult.matched.mode}-mode → ${switchResult.decision})`,
        );
        return {
          permissionDecision: switchResult.decision,
          permissionDecisionReason: switchResult.reason,
        };
      }
    }

    const idempotencyKey = {
      kind: 'mutating' as const,
      key: `${event.sessionId}-${event.turnId ?? 'no-turn'}-pre`,
    };

    const policyInput: PolicyInput = {
      toolName: event.toolName,
      sessionId: event.sessionId,
      idempotencyKey,
      input: event.toolInput,
      phase: 'pre',
      ...(projectId !== undefined ? { projectId } : {}),
    };

    let result: Awaited<ReturnType<PolicyClient['evaluate']>>;
    try {
      result = await deps.policy.evaluate(policyInput);
    } catch (err) {
      preToolLogger.warn(
        {
          event: 'pre_tool_use_evaluator_threw',
          sessionId: event.sessionId,
          toolName: event.toolName,
          err: err instanceof Error ? err.message : String(err),
        },
        'policy evaluator threw; failing open',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'policy_check_unavailable' };
    }

    // F12 + F15 closure (2026-04-27): the pre-tool INFO log carries
    // sessionId, projectId, projectSlug, AND runId. The runId is
    // resolved synchronously from (projectId|__global__, sessionId);
    // costs ~1ms of SQLite roundtrip on the hot path which is well
    // within the §6 / §16-pattern-4 50ms PreToolUse latency budget,
    // and lets SOC2 / NHI auditors grep for a single runId across
    // bridge + MCP service log streams without joining
    // (projectId, sessionId) tuples.
    const lookupProjectId = projectId ?? GLOBAL_PROJECT_ID;
    let runId: string | null = null;
    try {
      runId = await lookupRunId(deps.db, lookupProjectId, event.sessionId);
    } catch (err) {
      preToolLogger.warn(
        {
          event: 'pre_tool_use_run_id_lookup_failed',
          sessionId: event.sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'lookupRunId threw; logging without runId',
      );
    }
    preToolLogger.info(
      {
        event: 'pre_tool_use_decision',
        sessionId: event.sessionId,
        toolName: event.toolName,
        agentType: event.agentType,
        permissionDecision: result.decision,
        matchedRuleId: result.matchedRuleId,
        ...(slug !== undefined ? { projectSlug: slug } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        runId: runId ?? 'unresolved',
      },
      'pre-tool-use decision',
    );

    // Schedule the audit write if the recorder is wired. The recorder
    // skips the write when projectId is undefined (NOT NULL FK), so
    // dev sessions without a registered project still get the
    // INFO-log decision record above without a 500 from the audit.
    if (deps.runRecorder !== undefined) {
      deps.runRecorder.recordPolicyDecision({
        event,
        projectId,
        decision: result.decision,
        reason: result.reason,
        matchedRuleId: result.matchedRuleId,
      });
    }

    return {
      permissionDecision: result.decision,
      permissionDecisionReason: result.reason,
    };
  };
}
