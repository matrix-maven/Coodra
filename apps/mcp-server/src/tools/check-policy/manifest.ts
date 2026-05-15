import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { type CheckPolicyHandlerDeps, createCheckPolicyHandler } from './handler.js';
import { type CheckPolicyInput, checkPolicyInputSchema, checkPolicyOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__check_policy` (§24.4, S14).
 *
 * Factory-shaped because the handler closes over a `DbHandle` for
 * projects-slug resolution + `recordPolicyDecision` audit write.
 *
 * Idempotency-key kind is `mutating` — the tool writes to
 * `policy_decisions`. Key shape is `pd:{sessionId}:{toolName}:{eventType}`
 * per S7b's locked audit-key format (`system-architecture.md §4.3`).
 * This is the same shape the DB UNIQUE index enforces, so the
 * registry log correlator and the DB dedupe agree on the retry axis.
 * The registry does NOT dedupe using this key; dedupe is enforced by
 * the `policy_decisions.idempotency_key` UNIQUE constraint via
 * `ON CONFLICT DO NOTHING` inside `recordPolicyDecision`.
 *
 * §24.3 description anatomy (five-part recipe + 40–80 word band) is
 * enforced by `@coodra/shared/test-utils::assertManifestDescriptionValid`.
 */

const checkPolicyIdempotencyKey: IdempotencyKeyBuilder<CheckPolicyInput> = (input, _ctx) => {
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : 'probe';
  const toolName = typeof input?.toolName === 'string' && input.toolName.length > 0 ? input.toolName : 'probe';
  const eventType = typeof input?.eventType === 'string' && input.eventType.length > 0 ? input.eventType : 'probe';
  // F14 closure (2026-04-27): include toolUseId so distinct invocations
  // within a session don't collide on the registry-level dedupe (which
  // mirrors the DB audit-key shape).
  const toolUseId = typeof input?.toolUseId === 'string' && input.toolUseId.length > 0 ? input.toolUseId : 'no-turn';
  return {
    kind: 'mutating',
    key: `pd:${sessionId}:${toolUseId}:${toolName}:${eventType}`.slice(0, 200),
  };
};

export function createCheckPolicyToolRegistration(
  deps: CheckPolicyHandlerDeps,
): ToolRegistration<typeof checkPolicyInputSchema, typeof checkPolicyOutputSchema> {
  return {
    name: 'check_policy',
    title: 'Coodra: check_policy',
    description:
      'Call this BEFORE every file write, shell command, or destructive operation. Returns "allow", "ask", or "deny" — ' +
      'project-scoped policy rules decide. If the response is "deny", DO NOT proceed — report the reason to the user and stop. ' +
      'Fail-open on evaluator faults (breaker / timeout / throw) — the tool returns { permissionDecision: "allow", ' +
      'reason: "policy_engine_unavailable", failOpen: true }. ' +
      'Returns { ok: true, permissionDecision, reason, ruleReason, matchedRuleId, failOpen } on success, or ' +
      '{ ok: false, error: "project_not_found", howToFix } if the projectSlug is not registered.',
    inputSchema: checkPolicyInputSchema,
    outputSchema: checkPolicyOutputSchema,
    idempotencyKey: checkPolicyIdempotencyKey,
    handler: createCheckPolicyHandler(deps),
  };
}
