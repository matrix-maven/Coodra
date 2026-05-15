import type { PolicyDecisionPayloadV1, RunIdResolution } from '@coodra/cli/lib/outbox';
import { type DbHandle, postgresSchema, scheduleAuditWriteWithSync, sqliteSchema } from '@coodra/db';
import { buildPolicyDecisionIdempotencyKey } from '@coodra/policy';
import { createLogger } from '@coodra/shared';
import { eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import type { CheckPolicyInput, CheckPolicyOutput } from './schema.js';

/**
 * Handler factory for `coodra__check_policy` (§24.4, S14).
 *
 * S14 is the long-deferred first caller of `recordPolicyDecision`
 * (exported from `lib/policy.ts` since S7b — see
 * `context_memory/decisions-log.md` 2026-04-24 S7b entry's
 * "audit-write wire code" item). The S7b deferral closes here:
 * full hook-event context (`projectId`, `agentType`, `eventType`,
 * `runId`, `toolName`, `toolInputSnapshot`) is threaded from the
 * input into the audit helper.
 *
 * Flow:
 *   1. Resolve `projectSlug → projects.id`. Missing →
 *      `{ ok: false, error: 'project_not_found', howToFix }`
 *      soft-failure. Note: lookup miss is NOT fail-open — fail-open
 *      covers evaluator faults (throw / breaker / timeout), not
 *      caller-addressable errors. §7 canonical list only collapses
 *      evaluator unavailability; a missing project registration is
 *      a M03 client concern (see decisions-log 2026-04-24 S14 entry
 *      for the Hooks-Bridge handling note).
 *   2. Build `PolicyInput` with `projectId` threaded through — the
 *      evaluator (S14 upgrade) keys its cache per projectId and the
 *      rule loader filters by `policies.project_id`. Supplies a
 *      synthetic idempotencyKey so the PolicyClient surface is
 *      satisfied; the key is not used for dedupe (the DB UNIQUE on
 *      `policy_decisions.idempotency_key` is the enforcer).
 *   3. `ctx.policy.evaluate(input)` — cache-first, cockatiel-fused,
 *      fail-open on every error. Returns
 *      `{ decision, reason, matchedRuleId }` where `decision` is
 *      `'allow' | 'deny'` (never `'ask'` at M02 — see §24.4 note).
 *   4. Map to response:
 *        permissionDecision = evaluator's decision (never 'ask')
 *        reason             = machine enum (no_rule_matched |
 *                             rule_matched | policy_engine_unavailable)
 *        ruleReason         = rule.reason text when matched, else null
 *        matchedRuleId      = evaluator passthrough
 *        failOpen           = (reason === 'policy_engine_unavailable')
 *   5. Fire audit write async via `setImmediate` — the handler
 *      returns BEFORE the `policy_decisions` row is visible.
 *      Fire-and-forget; errors are caught and logged (non-fatal).
 *      Rationale: the check_policy tool's latency is in the
 *      <10ms hook-SLO path (§24.4); the audit INSERT is durable
 *      but off the critical path.
 *   6. The audit row's `reason` column gets the human text for
 *      matched rules (so a later `SELECT ... FROM policy_decisions`
 *      displays actionable info) and the enum code otherwise.
 *
 * `toolInputSnapshot` is the JSON serialisation of `toolInput`,
 * truncated to 8 KiB to prevent `policy_decisions` bloat from
 * agent-supplied large-body inputs (user Q4 push-back 2026-04-24).
 * A `…[truncated:N]` suffix preserves original-size forensics.
 *
 * `'ask'` never reaches the response at M02 — the evaluator only
 * emits `'allow' | 'deny'`. `'ask'` stays in the output enum for
 * forward compatibility with CODEOWNERS and branch-protection
 * integrations (future slices will populate it).
 */

const handlerLogger = createLogger('mcp-server.tool.check_policy');

const TOOL_INPUT_SNAPSHOT_MAX = 8192 as const;
/** Sentinel `'policy_check_unavailable'` is what the S7b evaluator emits on fail-open; S14 maps to the locked enum. */
const EVALUATOR_FAIL_OPEN_REASON = 'policy_check_unavailable';

export interface CheckPolicyHandlerDeps {
  readonly db: DbHandle;
}

async function resolveProjectId(db: DbHandle, projectSlug: string): Promise<string | null> {
  if (db.kind === 'sqlite') {
    const rows = await db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  const rows = await db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  return rows[0]?.id ?? null;
}

function truncateToolInputSnapshot(toolInput: Record<string, unknown>): string {
  let raw: string;
  try {
    raw = JSON.stringify(toolInput);
  } catch {
    return '[unserialisable]';
  }
  if (raw.length <= TOOL_INPUT_SNAPSHOT_MAX) return raw;
  return `${raw.slice(0, TOOL_INPUT_SNAPSHOT_MAX)}…[truncated:${raw.length}]`;
}

export function createCheckPolicyHandler(deps: CheckPolicyHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createCheckPolicyHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createCheckPolicyHandler: deps.db must be a DbHandle');
  }

  return async function checkPolicyHandler(input: CheckPolicyInput, ctx: ToolContext): Promise<CheckPolicyOutput> {
    const projectId = await resolveProjectId(deps.db, input.projectSlug);
    if (projectId === null) {
      handlerLogger.info(
        {
          event: 'check_policy_project_not_found',
          projectSlug: input.projectSlug,
          sessionId: input.sessionId,
          requestSessionId: ctx.sessionId,
        },
        'check_policy: projectSlug does not match a projects row — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix:
          'Register the project via the CLI (`coodra init`) or verify the slug matches an existing entry in the projects table.',
      };
    }

    const phase: 'pre' | 'post' = input.eventType === 'PreToolUse' ? 'pre' : 'post';
    const evalResult = await ctx.policy.evaluate({
      toolName: input.toolName,
      phase,
      sessionId: input.sessionId,
      input: input.toolInput,
      idempotencyKey: ctx.idempotencyKey,
      projectId,
    });

    // Map evaluator reason → locked output enum (user Q4 sign-off).
    let reason: 'no_rule_matched' | 'rule_matched' | 'policy_engine_unavailable';
    let ruleReason: string | null;
    if (evalResult.reason === EVALUATOR_FAIL_OPEN_REASON) {
      reason = 'policy_engine_unavailable';
      ruleReason = null;
    } else if (evalResult.matchedRuleId === null) {
      reason = 'no_rule_matched';
      ruleReason = null;
    } else {
      reason = 'rule_matched';
      ruleReason = evalResult.reason;
    }
    const failOpen = reason === 'policy_engine_unavailable';

    // Audit-row reason: human text when matched, enum code otherwise,
    // so a DBA reading policy_decisions can understand WHY without
    // joining policy_rules.
    const auditReason = ruleReason ?? reason;
    const toolInputSnapshot = truncateToolInputSnapshot(input.toolInput);

    // Module 03.1: durable enqueue. The handler returns BEFORE the
    // destination INSERT fires; the OutboxWorker drains
    // `pending_jobs` and applies the row via the canonical
    // dispatcher (which calls `recordPolicyDecision` at dispatch
    // time). Idempotency at the destination (the F14 4-segment
    // `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}` key)
    // dedupes retries.
    const resolution: RunIdResolution = { kind: 'pre_resolved', runId: input.runId ?? null };
    const auditPayload: PolicyDecisionPayloadV1 = {
      v: 1,
      resolution,
      projectId,
      sessionId: input.sessionId,
      agentType: input.agentType,
      eventType: input.eventType,
      toolName: input.toolName,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      toolInputSnapshot,
      permissionDecision: evalResult.decision,
      matchedRuleId: evalResult.matchedRuleId,
      reason: auditReason,
    };
    const policyIdempotencyKey = buildPolicyDecisionIdempotencyKey({
      sessionId: input.sessionId,
      ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
      toolName: input.toolName,
      eventType: input.eventType,
    });
    void scheduleAuditWriteWithSync(deps.db, {
      audit: { queue: 'policy_decision', payload: auditPayload },
      sync: { table: 'policy_decisions', lookup: { kind: 'idempotency_key', value: policyIdempotencyKey } },
    }).catch((err) =>
      handlerLogger.warn(
        {
          event: 'policy_audit_enqueue_failed',
          sessionId: input.sessionId,
          toolName: input.toolName,
          eventType: input.eventType,
          err: err instanceof Error ? err.message : String(err),
        },
        'check_policy: durable enqueue failed — decision already returned to caller',
      ),
    );

    return {
      ok: true,
      permissionDecision: evalResult.decision,
      reason,
      ruleReason,
      matchedRuleId: evalResult.matchedRuleId,
      failOpen,
    };
  };
}
