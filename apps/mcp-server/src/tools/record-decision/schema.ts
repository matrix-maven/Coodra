import { z } from 'zod';

/**
 * Input + output schemas for `coodra__record_decision` (§24.4, S13).
 *
 * Input caps are defensive — oversized inputs fail Zod validation and
 * surface through the registry's generic `invalid_input` envelope.
 * Not a user-recoverable soft-failure: oversized decision bodies are
 * a caller bug, not a mis-config.
 *
 * The handler dedupes on `dec:{runId}:{sha256(description).slice(0,32)}`.
 * Two calls with the same `runId` + identical `description` collide on
 * the `decisions.idempotency_key` unique index and the second call
 * returns the first row's `decisionId` — `rationale` + `alternatives`
 * changes on the retry are discarded. Different `description` strings
 * persist as distinct rows (multi-decision-per-run is explicitly
 * supported).
 *
 * Size caps:
 *   - description: 2 KiB  — one paragraph, commit-subject+body shape
 *   - rationale:   8 KiB  — one section of a decisions-log entry
 *   - alternatives: up to 10 strings of 512 chars each
 */

const MAX_DESCRIPTION = 2048 as const;
const MAX_RATIONALE = 8192 as const;
const MAX_ALTERNATIVES = 10 as const;
const MAX_ALTERNATIVE_LEN = 512 as const;

const MAX_CONTEXT = 4096 as const;
const MAX_IMPACT_ITEMS = 30 as const;
const MAX_IMPACT_LEN = 512 as const;

export const recordDecisionInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
    description: z
      .string()
      .min(1, 'description is required')
      .max(MAX_DESCRIPTION, `description must be at most ${MAX_DESCRIPTION} characters`),
    rationale: z
      .string()
      .min(1, 'rationale is required')
      .max(MAX_RATIONALE, `rationale must be at most ${MAX_RATIONALE} characters`),
    alternatives: z
      .array(z.string().min(1).max(MAX_ALTERNATIVE_LEN))
      .max(MAX_ALTERNATIVES, `alternatives must be at most ${MAX_ALTERNATIVES} items`)
      .optional(),
    /** M05 — what triggered this decision (user request, error, design review). */
    context: z.string().min(1).max(MAX_CONTEXT).optional(),
    /** M05 — affected modules / API surfaces / files. JSON-encoded by handler. */
    impact: z.array(z.string().min(1).max(MAX_IMPACT_LEN)).max(MAX_IMPACT_ITEMS).optional(),
    /** M05 — how certain this decision is. Maps directly to decisions.confidence column. */
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    /** M05 — can this be undone without major cost. Stored as boolean (NULL = unknown). */
    reversible: z.boolean().optional(),
  })
  .strict()
  .describe('Input for coodra__record_decision.');

/**
 * Output schema — discriminated union on `ok` per §9.1.2 canonical
 * soft-failure shape. Success includes `createdAt` for symmetry with
 * `save_context_pack.savedAt`; agents echo this back to confirm the
 * decision was persisted at a real wall-clock time.
 */
const successBranch = z
  .object({
    ok: z.literal(true),
    decisionId: z.string().min(1),
    createdAt: z.string().datetime().describe('ISO 8601 timestamp the decisions row was inserted.'),
    // `true` when this call created a new row; `false` when the
    // idempotency key already existed and we returned the prior row.
    // Lets the agent detect silently-deduped retries without re-reading
    // the DB.
    created: z.boolean(),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

/**
 * Phase G slice G.6 — auth_required soft-failure.
 *
 * Returned in team mode when no verified Clerk JWT is available on
 * this machine. The agent surfaces `howToFix` to the user, who runs
 * `coodra login` and retries.
 */
const authRequiredBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('auth_required'),
    howToFix: z.string().min(1),
  })
  .strict();

export const recordDecisionOutputSchema = z.union([successBranch, runNotFoundBranch, authRequiredBranch]);

export type RecordDecisionInput = z.infer<typeof recordDecisionInputSchema>;
export type RecordDecisionOutput = z.infer<typeof recordDecisionOutputSchema>;
