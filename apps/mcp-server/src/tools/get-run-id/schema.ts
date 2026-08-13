import { runKeySegmentSchema } from '@coodra/shared';
import { z } from 'zod';

/**
 * Input schema for `coodra__get_run_id` (§24.4).
 *
 * `projectSlug` is the project identifier. The handler resolves this
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
 *   - `agentType` = `claude_code | codex | cursor | devin | antigravity | unknown` so the runs row's
 *     agent_type column is populated correctly (closes F10 — without
 *     it, MCP-minted rows defaulted to `unknown` regardless of which
 *     agent was active).
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
      .describe('Project slug (single global slug per §24.4).'),
    agentSessionId: runKeySegmentSchema
      .max(256, 'agentSessionId must be ≤256 chars')
      .optional()
      .describe(
        'Agent-supplied session id. When present, MCP uses this as runs.session_id ' +
          'so the bridge SessionStart row and this MCP get_run_id call resolve to ONE ' +
          'runs row. Omit to use the transport-generated sessionId (legacy).',
      ),
    agentType: z
      .enum(['claude_code', 'codex', 'cursor', 'devin', 'antigravity', 'unknown'])
      .optional()
      .describe(
        'Agent type stamp for the runs row. Fallback only: it applies when the transport ' +
          'cannot resolve the agent itself (resolves "unknown" — e.g. HTTP with an ' +
          'unrecognized client name, or stdio without a COODRA_AGENT_TYPE config stamp). ' +
          'A known transport-resolved identity wins over this param.',
      ),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        'Absolute path of the project root you are working in. Strongly recommended in solo mode: without it, ' +
          'an unregistered project cannot be verified against a local .coodra/config.json and this call returns ' +
          'project_not_registered instead of silently creating one.',
      ),
    confirmRegister: z
      .boolean()
      .optional()
      .describe(
        'Pass true only after the user has explicitly agreed to register this project with Coodra, in response ' +
          'to a prior project_not_registered result. Must be paired with cwd — without it the registration cannot ' +
          "persist and you'll be asked again next session. Do not set this speculatively — ask the user first.",
      ),
  })
  .strict()
  .describe('Input for coodra__get_run_id.');

/**
 * Output schema.
 *
 * The success branch returns the runId + ISO-8601 startedAt per
 * §24.4. Two soft-failure branches carry a structured error code +
 * `howToFix` string so the calling agent can surface actionable
 * guidance to the user instead of a generic tool-failure message:
 *
 *   - `project_not_found` — team mode only. An unknown slug is
 *     always a hard refusal in team mode; there is no auto-create
 *     path to gate here. Register via the Web App or `coodra init`.
 *   - `project_not_registered` — solo mode only. Registration guard
 *     (COOD-63): an unknown slug, or a previously auto-created row
 *     with no verified `cwd`, no longer silently mints/reuses a
 *     project. The caller must supply `cwd` matching a real
 *     `.coodra/config.json`, or `confirmRegister: true` after the
 *     user has explicitly agreed — see `handler.ts`'s
 *     `resolveOrRegisterProject`.
 *
 * Why modeled as data rather than throwing: the registry's generic
 * `handler_threw` envelope is reserved for programming bugs (database
 * outage, unexpected null). Both of these are user-recoverable
 * states; modeling them as data keeps the agent-reading contract
 * clean.
 *
 * `z.union`, not `discriminatedUnion` — two branches share the
 * `ok: false` literal, so `ok` alone can't discriminate between them
 * (see get-recipe/schema.ts and wiki-ask/schema.ts for the same
 * convention).
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

const getRunIdProjectNotRegistered = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_registered'),
    howToFix: z
      .string()
      .min(1)
      .describe(
        'Agent-surfaceable remediation string — ask the user to confirm registration, then either run ' +
          '`coodra init` or retry with confirmRegister: true.',
      ),
  })
  .strict();

export const getRunIdOutputSchema = z.union([getRunIdSuccess, getRunIdProjectNotFound, getRunIdProjectNotRegistered]);

export type GetRunIdInput = z.infer<typeof getRunIdInputSchema>;
export type GetRunIdOutput = z.infer<typeof getRunIdOutputSchema>;
