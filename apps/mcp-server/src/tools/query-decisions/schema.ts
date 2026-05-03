import { z } from 'zod';

/**
 * Input + output schemas for `contextos__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Read-only tool. The audit's §3.5 + §6 ground-level limit #2 surfaced
 * the gap: `record_decision` writes to the `decisions` table but
 * nothing in the 9-tool MCP surface reads it back. A new session
 * asking "what did we decide about X?" had no path other than
 * `search_packs_nl` (LIKE substring against pack content_excerpt,
 * single-project, frequently empty). This tool exposes the decisions
 * directly.
 *
 * Shape:
 *   Input:  { projectSlug, query?, runId?, limit? }
 *   Output: { ok: true, decisions: Array<DecisionEntry> }
 *         | { ok: false, error: 'project_not_found', howToFix }
 *
 * `query` is a substring filter applied with LIKE against both
 * `description` AND `rationale` (case-insensitive on SQLite via the
 * default LIKE collation; same with COLLATE on Postgres). When
 * absent, every decision in the project's run scope is returned up
 * to `limit`.
 *
 * `runId` is an optional narrower filter: when present, returns only
 * decisions for that exact run. Combined with `query`, both filters
 * must match.
 *
 * Default limit is 10 (parity with query_run_history). Upper bound 200.
 *
 * Decisions with NULL `run_id` (the orphan case after a run deletion;
 * see schema docblock) are NOT returned — query_decisions filters by
 * project, which requires a join through runs. Orphan decisions are
 * unreachable from this tool by design; they survive in the DB for
 * permanent history per ADR-007.
 */

const MAX_LIMIT = 200 as const;
const DEFAULT_LIMIT = 10 as const;

export const queryDecisionsInputSchema = z
  .object({
    projectSlug: z.string().min(1, 'projectSlug is required').max(256),
    query: z.string().min(1).max(500).optional().describe('Optional LIKE substring against description + rationale.'),
    runId: z.string().min(1).max(512).optional().describe('Optional narrower filter to a single run.'),
    limit: z
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`)
      .default(DEFAULT_LIMIT),
  })
  .strict()
  .describe('Input for contextos__query_decisions.');

const decisionEntrySchema = z
  .object({
    id: z.string().min(1).describe('decisions.id, e.g. dec_<uuid>.'),
    runId: z
      .string()
      .min(1)
      .describe('runs.id this decision belonged to. Always non-null in this tool (see schema docblock).'),
    description: z.string().describe('What was decided. One sentence.'),
    rationale: z.string().describe('Why this approach over alternatives.'),
    alternatives: z
      .array(z.string())
      .describe(
        'Alternatives the agent considered. Empty array when the original record had no alternatives or stored a non-JSON blob.',
      ),
    createdAt: z.string().datetime().describe('ISO 8601 timestamp the decision was recorded.'),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    decisions: z.array(decisionEntrySchema),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const queryDecisionsOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type QueryDecisionsInput = z.infer<typeof queryDecisionsInputSchema>;
export type QueryDecisionsOutput = z.infer<typeof queryDecisionsOutputSchema>;
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;
