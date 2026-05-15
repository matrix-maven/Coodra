import { runKeySegmentSchema } from '@coodra/shared';
import { z } from 'zod';

/**
 * Input schema for `coodra__get_run_id` (§24.4).
 *
 * `projectSlug` is the feature-pack-namespaced project identifier
 * (see `context_memory/decisions-log.md` 2026-04-24 12:15 "feature_
 * packs is single-namespace-by-slug" — the same slug convention the
 * MCP server uses for `feature-pack.get`). The handler resolves this
 * to `projects.id` via `projects.slug` unique lookup.
 *
 * F9 + F10 closure (verification 2026-04-27): the optional
 * `agentSessionId` and `agentType` inputs let the bridge and MCP
 * server agree on a single canonical `runs` row per logical agent
 * session. Without them, the bridge writes `runs.session_id =
 * event.session_id` (the agent's id) and MCP writes `runs.session_id
 * = ctx.sessionId` (transport-generated `stdio-…`/`http-…`); the
 * unique index `(project_id, session_id)` enforces uniqueness per
 * pair, so each surface created its own row. With `agentSessionId`
 * supplied the SAME row is found-or-inserted from both surfaces,
 * fulfilling §1's "run = 1:1 with agent session" intent.
 *
 * Agents (or their harnesses) should pass:
 *   - `agentSessionId` = the same `session_id` they fire at the
 *     hooks bridge in the SessionStart payload.
 *   - `agentType` = `claude_code | cursor | windsurf | codex | unknown`
 *     so the runs row's agent_type column is populated correctly
 *     (closes F10 — without it, MCP-minted rows defaulted to
 *     `unknown` regardless of which agent was active). `codex` added
 *     beta.95 — Codex/Windsurf Scope A integration.
 *
 * Both fields are optional and backward-compatible: callers that
 * omit them get the legacy behaviour (ctx.sessionId, transport-
 * guess agentType).
 */
export const getRunIdInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be at most 128 characters')
      .describe('Project slug (same namespace as feature-pack slugs — single global slug per §24.4).'),
    agentSessionId: runKeySegmentSchema
      .max(256, 'agentSessionId must be ≤256 chars')
      .optional()
      .describe(
        'Agent-supplied session id. When present, MCP uses this as runs.session_id ' +
          'so the bridge SessionStart row and this MCP get_run_id call resolve to ONE ' +
          'runs row. Omit to use the transport-generated sessionId (legacy).',
      ),
    agentType: z
      .enum(['claude_code', 'cursor', 'windsurf', 'codex', 'unknown'])
      .optional()
      .describe(
        'Agent type stamp for the runs row. When present, overrides the transport guess ' +
          '(which defaults to "unknown" for HTTP).',
      ),
  })
  .strict()
  .describe('Input for coodra__get_run_id.');

/**
 * Output schema — discriminated union on `ok`.
 *
 * The success branch returns the runId + ISO-8601 startedAt per
 * §24.4. The soft-failure branch carries a structured
 * `project_not_found` code + `howToFix` string so the calling agent
 * can surface actionable guidance to the user instead of a generic
 * tool-failure message. Per user directive Q1 (2026-04-24 14:00):
 * solo mode auto-creates the `projects` row (so this branch only
 * fires in team mode); team mode returns this branch so the user can
 * register the project via the Web App or `coodra init` CLI.
 *
 * Why discriminated union rather than throwing: the registry's
 * generic `handler_threw` envelope is reserved for programming bugs
 * (database outage, unexpected null). "Project not registered" is a
 * user-recoverable state; modeling it as data keeps the agent-
 * reading contract clean.
 */
const getRunIdSuccess = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1).describe('run:{projectId}:{sessionId}:{uuid} per §4.3 idempotency-key format.'),
    startedAt: z.string().datetime().describe('ISO 8601 timestamp the runs row was first inserted.'),
  })
  .strict();

const getRunIdProjectNotFound = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z
      .string()
      .min(1)
      .describe('Agent-surfaceable remediation string — register via Web App or `coodra init`.'),
  })
  .strict();

export const getRunIdOutputSchema = z.discriminatedUnion('ok', [getRunIdSuccess, getRunIdProjectNotFound]);

export type GetRunIdInput = z.infer<typeof getRunIdInputSchema>;
export type GetRunIdOutput = z.infer<typeof getRunIdOutputSchema>;
