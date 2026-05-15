import {
  type DbHandle,
  findKillSwitchMatchingEvent,
  type KillSwitchRecord,
  listActiveKillSwitches,
} from '@coodra/db';
import { createLogger } from '@coodra/shared';

/**
 * `apps/hooks-bridge/src/lib/kill-switch-evaluator` — short-circuit
 * evaluator the pre-tool-use chain consults BEFORE the policy
 * evaluator (Module 08b S2; see `docs/feature-packs/08b-cli-expansion/implementation.md` §S2).
 *
 * Wiring contract per `pre-tool-use.ts`:
 *
 *   const switchResult = await killSwitchEvaluator.check({ projectId, toolName, agentType });
 *   if (switchResult !== null) {
 *     runRecorder.recordPolicyDecision({ event, projectId, decision: switchResult.decision, reason: switchResult.reason, matchedRuleId: null });
 *     return { permissionDecision: switchResult.decision, permissionDecisionReason: switchResult.reason };
 *   }
 *   // fall through to the existing policy chain
 *
 * Per the OQ-1 lock (2026-05-03):
 *   - hard-mode match → decision='deny'
 *   - soft-mode match → decision='allow' (the audit row preserves the
 *     observability story; no enforcement)
 *
 * Per the OQ-2 lock the polymorphic `(scope, target)` shape lives in
 * the schema; the SQL-layer filter (`scope IN ('global','tool',
 * 'agent_type') OR (scope='project' AND target=projectId)`) happens
 * inside `listActiveKillSwitches`. The in-memory `findKillSwitchMatchingEvent`
 * narrows down to the single row matching the event.
 *
 * Cache TTL: 5 seconds by default — much shorter than the policy
 * client's 60s because pause/resume should feel instantaneous to
 * the operator (a 60s wait between `coodra pause` and "the
 * agent is now denied" is a UX failure). The cache key is the
 * projectId (or a sentinel for null projects so unregistered cwds
 * still get O(1) hits).
 *
 * Failure-mode discipline (system-architecture.md §7 fail-open):
 *   - DB throw → log WARN with `kill_switch_check_unavailable`,
 *     return `null`. The pre-tool-use chain falls through to the
 *     policy evaluator (which is the second-line defense — its
 *     own breaker handles persistent DB outages).
 *   - Cache hit on stale data is acceptable (5s window). The
 *     operator's "I just paused, why isn't it active?" delay is
 *     bounded; the alternative (per-call DB read on the hot path)
 *     blows the §6 / §16-pattern-4 50ms PreToolUse latency budget
 *     under any meaningful event volume.
 *
 * The evaluator never enqueues sync rows. Per OQ-8 lock kill
 * switches are local-only in M08b; cross-developer sync is M04's
 * surface.
 */

const killSwitchEvaluatorLogger = createLogger('hooks-bridge.kill-switch-evaluator');

const NULL_PROJECT_CACHE_KEY = '__null_project__' as const;

export interface CreateKillSwitchEvaluatorDeps {
  readonly db: DbHandle;
  /** Default 5_000 ms. Override for tests (e.g. 0 to disable caching). */
  readonly cacheMs?: number;
  /** Default `() => new Date()`. Override for deterministic expiry tests. */
  readonly clock?: () => Date;
}

export interface KillSwitchEvaluationInput {
  /** Resolved project id from `projectSlugResolver`. `null` when no `.coodra.json` is present. */
  readonly projectId: string | null;
  readonly toolName: string;
  readonly agentType: string;
}

export interface KillSwitchMatch {
  readonly matched: KillSwitchRecord;
  /** `'deny'` for hard-mode matches; `'allow'` for soft-mode matches (audit-only). */
  readonly decision: 'deny' | 'allow';
  /** Always `kill_switch_paused:<id>` — surfaced verbatim in `policy_decisions.reason` and the per-agent hook envelope. */
  readonly reason: string;
}

export interface KillSwitchEvaluator {
  check(input: KillSwitchEvaluationInput): Promise<KillSwitchMatch | null>;
  /**
   * Test-only: invalidate the cache. Production code paths never
   * call this — the cache TTL handles freshness. Tests use it to
   * assert behaviour under specific cache states without waiting.
   */
  invalidate(projectId?: string | null): void;
  /** Test-only: introspect cache size. */
  cacheSize(): number;
}

export function createKillSwitchEvaluator(deps: CreateKillSwitchEvaluatorDeps): KillSwitchEvaluator {
  const cacheMs = deps.cacheMs ?? 5_000;
  const clock = deps.clock ?? (() => new Date());
  const cache = new Map<string, { switches: KillSwitchRecord[]; expiresAt: number }>();

  function cacheKeyFor(projectId: string | null): string {
    return projectId === null ? NULL_PROJECT_CACHE_KEY : projectId;
  }

  async function fetchActive(projectId: string | null, now: Date): Promise<KillSwitchRecord[] | null> {
    try {
      return await listActiveKillSwitches(deps.db, projectId, { now });
    } catch (err) {
      killSwitchEvaluatorLogger.warn(
        {
          event: 'kill_switch_check_unavailable',
          projectId,
          err: err instanceof Error ? err.message : String(err),
        },
        'kill-switch lookup threw; failing open to policy evaluator',
      );
      return null;
    }
  }

  return {
    async check(input) {
      const now = clock();
      const cacheKey = cacheKeyFor(input.projectId);
      let switches: KillSwitchRecord[] | null = null;

      const cached = cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > now.getTime()) {
        switches = cached.switches;
      }
      if (switches === null) {
        switches = await fetchActive(input.projectId, now);
        if (switches === null) {
          // DB unavailable — fail open. The pre-tool-use chain
          // falls through to the policy evaluator. We don't cache
          // the failure: every call retries until the DB recovers
          // (the per-call WARN log surfaces persistent outages).
          return null;
        }
        cache.set(cacheKey, { switches, expiresAt: now.getTime() + cacheMs });
      }

      if (switches.length === 0) return null;

      const matched = findKillSwitchMatchingEvent(switches, {
        ...(input.projectId !== null ? { projectId: input.projectId } : {}),
        toolName: input.toolName,
        agentType: input.agentType,
      });
      if (matched === null) return null;

      const decision: 'deny' | 'allow' = matched.mode === 'hard' ? 'deny' : 'allow';
      const reason = `kill_switch_paused:${matched.id}`;
      killSwitchEvaluatorLogger.info(
        {
          event: 'kill_switch_match',
          killSwitchId: matched.id,
          scope: matched.scope,
          target: matched.target,
          mode: matched.mode,
          decision,
          toolName: input.toolName,
          agentType: input.agentType,
        },
        `kill switch matched (${matched.mode}-mode → ${decision})`,
      );
      return { matched, decision, reason };
    },

    invalidate(projectId) {
      if (projectId === undefined) {
        cache.clear();
        return;
      }
      cache.delete(cacheKeyFor(projectId));
    },

    cacheSize() {
      return cache.size;
    },
  };
}
