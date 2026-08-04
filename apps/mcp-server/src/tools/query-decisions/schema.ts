import { z } from 'zod';

/**
 * Input + output schemas for `coodra__query_decisions` (Slice 4 — 2026-05-03 audit).
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
 * `query` is BM25-ranked full-text search (2026-08-03) against both
 * `description` AND `rationale` via `decisions_fts`/`decisions.search_vector`
 * — see `packages/db/drizzle/{sqlite,postgres}/00{24,26}_fts_search.sql`.
 * Every word must appear (implicit AND); results are ordered best-match
 * first instead of by `createdAt`. When absent, every decision in the
 * project's run scope is returned up to `limit`, ordered by recency.
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
    query: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Optional BM25-ranked keyword search against description + rationale. Best match first.'),
    runId: z.string().min(1).max(512).optional().describe('Optional narrower filter to a single run.'),
    // Module 09 J2 (2026-05-31, ADR-016 — Jira = Direct). Filter to
    // decisions whose run is bound to this Jira issue (runs.issue_ref, set
    // by link_run_to_issue). Case-insensitive — the "what was decided for
    // PROJ-412?" query.
    issueRef: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Optional filter to decisions whose run is bound to this tracker issue key (e.g. PROJ-412), case-insensitive.',
      ),
    // coodra-work redesign (2026-08-03). runs.workPackId already existed
    // (Work Pack foundation); this filter spans every run tied to a Work
    // Pack, not just one — needed because a pack can be worked across
    // multiple resumed sessions/runs, so a single issueRef/runId filter
    // would miss decisions recorded in earlier runs of the same pack.
    // Primary filter for the sync-back flow: gather everything recorded
    // against a Work Pack before composing a write-back comment.
    workPackId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('Optional filter to decisions whose run belongs to this Work Pack, across every run tied to it.'),
    // coodra-work redesign, round 2. Matches decisions linked to workPackId
    // either via the run they belong to OR the direct many-to-many
    // work_pack_decision_links tag (set by record_decision's workPackSlugs).
    // When true, also walks work_pack_relationships one hop from
    // workPackId and includes decisions linked to those related packs too
    // — e.g. a decision made on Pack 1 that a related, concurrently-worked
    // Pack 2 should already know about. Ignored when workPackId is absent.
    includeRelated: z.boolean().default(false),
    limit: z
      .number()
      .int()
      .min(1, 'limit must be >= 1')
      .max(MAX_LIMIT, `limit must be <= ${MAX_LIMIT}`)
      .default(DEFAULT_LIMIT),
  })
  .strict()
  .describe('Input for coodra__query_decisions.');

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
