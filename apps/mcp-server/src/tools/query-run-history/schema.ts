import { z } from 'zod';

/**
 * Input + output schemas for `coodra__query_run_history` (§24.4, S12).
 *
 * Read-only tool. The §24.4 shape is:
 *   Input:  { projectSlug, status?: 'in_progress' | 'completed' | 'failed', limit? }
 *   Output: { runs: Array<{ runId, startedAt, endedAt, status, title, issueRef, prRef }> }
 *
 * `title` is nullable in practice: the handler LEFT JOINs
 * `context_packs` for the run-scoped title, and an `in_progress` run
 * that has not yet called `save_context_pack` will have no matching
 * row — the field is returned as `null` rather than omitted so the
 * output shape is stable across run states. §24.4 is amended
 * same-commit to document the nullability.
 *
 * Default limit is 10 (§S12). Upper bound is 200 so an agent cannot
 * accidentally fetch the entire history on one call.
 */

const MAX_LIMIT = 200 as const;
const DEFAULT_LIMIT = 10 as const;

export const queryRunHistoryInputSchema = z
  .object({
    projectSlug: z.string().min(1, 'projectSlug is required').max(256),
    // Slice 8 (2026-05-03 audit §14.3): 'abandoned' is the new status
    // bridge SessionStart sets on prior in_progress runs that never
    // received a SessionEnd. Surfaced here so an agent can ask "show me
    // the runs that were abandoned" if needed; default behaviour
    // (status omitted) returns every status including 'abandoned'.
    status: z.enum(['in_progress', 'completed', 'failed', 'abandoned']).optional(),
    // Module 09 J2 (2026-05-31, ADR-016 — Jira = Direct). Filter to runs
    // bound to a specific Jira issue (runs.issue_ref, set by
    // link_run_to_issue). Case-insensitive — matched upper-cased against
    // the normalised stored key. This is the "what touched PROJ-412?" query.
    issueRef: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe('Filter to runs bound to this Jira issue key (e.g. PROJ-412), case-insensitive.'),
    limit: z
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`)
      .default(DEFAULT_LIMIT),
    runId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Optional. Pass your current runId (from get_run_id) so this prior-work recall is recorded as an mcp_call run_event for the ROI / knowledge-continuity metrics (/roi dashboard, `coodra roi`). Attribution-only — does not filter the history (use issueRef/status for that).',
      ),
  })
  .strict()
  .describe('Input for coodra__query_run_history.');

/**
 * Output schema — discriminated union on `ok` per §9.1.2 canonical
 * soft-failure shape. Success branch carries the run list; only soft-
 * failure is `project_not_found` (the projectSlug is not registered).
 *
 * Empty results (valid project, zero matching runs) → `ok: true, runs: []`,
 * NOT a soft-failure. "No matches" is a valid success state.
 */
const runEntrySchema = z
  .object({
    runId: z.string().min(1),
    startedAt: z.string().datetime().describe('ISO 8601 timestamp the run row was created.'),
    endedAt: z.string().datetime().nullable().describe('ISO 8601 end timestamp; null for in-progress runs.'),
    status: z.enum(['in_progress', 'completed', 'failed', 'abandoned']),
    title: z.string().nullable().describe('Context-pack title for the run, or null if no pack exists yet.'),
    issueRef: z.string().nullable().describe('JIRA issue key; null until the JIRA integration binds one.'),
    prRef: z.string().nullable().describe('GitHub PR ref; null until the GitHub integration binds one.'),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    runs: z.array(runEntrySchema),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const queryRunHistoryOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type QueryRunHistoryInput = z.infer<typeof queryRunHistoryInputSchema>;
export type QueryRunHistoryOutput = z.infer<typeof queryRunHistoryOutputSchema>;
export type RunHistoryEntry = z.infer<typeof runEntrySchema>;
