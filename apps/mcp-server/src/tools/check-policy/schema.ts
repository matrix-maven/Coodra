import { runKeySegmentSchema } from '@coodra/shared';
import { z } from 'zod';

/**
 * Input + output schemas for `coodra__check_policy` (§24.4, S14).
 *
 * §24.4 base input:
 *   { projectSlug, sessionId, agentType, eventType, toolName, toolInput }
 * S14 additions:
 *   - `runId?: string` — optional, threads into `policy_decisions.run_id`
 *     (nullable per §4.3; PreToolUse can fire before a run exists).
 *
 * `toolInput` is a caller-supplied record of unknown shape. We accept any
 * object but reject primitives/arrays — policies can only match against
 * record-shaped payloads (path, command, body). Oversized payloads are
 * not rejected at the schema layer — the handler truncates the JSON
 * serialisation to 8 KiB when writing the audit row.
 *
 * Reason-enum lock (locked by user Q4 sign-off 2026-04-24):
 *   - `no_rule_matched`         — default allow, no rule fired
 *   - `rule_matched`            — explicit allow/deny from a fired rule
 *   - `policy_engine_unavailable` — fail-open (breaker-open, timeout,
 *                                  or evaluator-throw all collapse here)
 * `failOpen: boolean` is computed from the reason enum; a unit test
 * locks the reason→failOpen mapping so observability can rely on either
 * axis.
 *
 * `ruleReason` carries the matched rule's human-readable `reason` column
 * text when `reason === 'rule_matched'`; otherwise `null`. Agents that
 * need to display "why was this blocked?" read `ruleReason`; systems
 * that branch on machine state read `reason`.
 *
 * `'ask'` stays in the output enum per §24.4 wording but the S14
 * evaluator never emits it — CODEOWNERS and branch-protection
 * integrations (future slices) will populate it. A unit test locks
 * this invariant across the M02 evaluator paths.
 */

export const checkPolicyInputSchema = z
  .object({
    projectSlug: z.string().min(1, 'projectSlug is required').max(256),
    // F5 closure (2026-04-27 verification): the framework PerCallContext
    // layer validates sessionId via runKeySegmentSchema, but a direct MCP
    // caller passing `sessionId: "has:colon"` previously bypassed that
    // gate. Applying the same schema here closes the gap defensively —
    // the bridge's normalizeSessionId pre-sanitises agent-supplied ids,
    // so this fires only on direct callers and on a regression in the
    // bridge boundary.
    sessionId: runKeySegmentSchema
      .max(256, 'sessionId must be ≤256 chars')
      .describe('Stable session id for this transport. Must not contain `:` (run-key separator).'),
    agentType: z.string().min(1, 'agentType is required').max(64),
    eventType: z.enum(['PreToolUse', 'PostToolUse']),
    toolName: z.string().min(1, 'toolName is required').max(256),
    toolInput: z.record(z.string(), z.unknown()),
    runId: z.string().min(1).max(256).optional(),
    // F14 closure (2026-04-27 verification): per-invocation turn id
    // (Claude Code `tool_use_id`, Cursor `tool_call_id`, Windsurf
    // `execution_id`). Threads into the audit-row idempotency key so
    // distinct invocations of the same tool within a session land
    // distinct policy_decisions rows. Optional for backward
    // compatibility — absent → `'no-turn'` fallback.
    toolUseId: z.string().min(1).max(256).optional(),
  })
  .strict()
  .describe('Input for coodra__check_policy.');

const successBranch = z
  .object({
    ok: z.literal(true),
    permissionDecision: z.enum(['allow', 'ask', 'deny']),
    reason: z.enum(['no_rule_matched', 'rule_matched', 'policy_engine_unavailable']),
    ruleReason: z
      .string()
      .nullable()
      .describe("Human-readable rule text; populated when reason === 'rule_matched', else null."),
    matchedRuleId: z.string().nullable(),
    failOpen: z
      .boolean()
      .describe(
        "True iff reason === 'policy_engine_unavailable'. Observability flag — distinguishes default-allow from explicit-allow.",
      ),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const checkPolicyOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type CheckPolicyInput = z.infer<typeof checkPolicyInputSchema>;
export type CheckPolicyOutput = z.infer<typeof checkPolicyOutputSchema>;
