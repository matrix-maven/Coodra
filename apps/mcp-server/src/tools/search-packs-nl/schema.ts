import { z } from 'zod';

/**
 * Input + output schemas for `coodra__search_packs_nl`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied semantic-KNN
 * path was removed alongside the abandoned Python NL Assembly service.
 * Search is now keyword-only (LIKE over title + content_excerpt + first
 * 2KB of content) ordered by recency. Agents apply their own relevance
 * ranking after reading candidates with `read_context_pack` — see
 * `docs/feature-packs/05-agent-driven-nl-assembly/spec.md` §5.3.
 *
 * The wire shape is intentionally narrower than pre-M05:
 *   - `embedding: number[]` — REMOVED
 *   - `notice: 'no_embeddings_yet'` — REMOVED
 *   - `embedding_dim_mismatch` soft-failure branch — REMOVED
 *   - default limit raised from 10 to 50 (recency feed, not top-K)
 */

const MAX_QUERY_LEN = 4096 as const;
const MAX_LIMIT = 200 as const;

export const searchPacksNlInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be at most 128 characters')
      .describe('Project slug — same single-namespace convention as get_run_id / get_feature_pack.'),
    query: z
      .string()
      .min(1, 'query is required')
      .max(MAX_QUERY_LEN, `query must be at most ${MAX_QUERY_LEN} characters`)
      .describe(
        'Keyword(s) to LIKE-match against title + content_excerpt + first 2KB of content. Single token or short phrase works best; for semantic exploration call list_context_packs and reason over titles instead.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`Max results (default 50, capped at ${MAX_LIMIT}). Ordered by created_at DESC.`),
    runId: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'Optional. Pass your current runId (from get_run_id) so this knowledge-reuse read is recorded as an mcp_call run_event for the ROI / knowledge-continuity metrics (/roi dashboard, `coodra roi`). Attribution-only — does not filter or change results.',
      ),
  })
  .strict()
  .describe('Input for coodra__search_packs_nl.');

const packResultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    excerpt: z.string(),
    /** Always null post-M05 — search is keyword-only, no relevance score is computed. Agent ranks. */
    score: z.number().nullable(),
    savedAt: z.string().datetime(),
    runId: z.string().min(1),
    /** Provenance — 'agent' rows are canonical narratives; 'bridge_auto' rows are structured digests. */
    source: z.enum(['agent', 'bridge_auto']),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    packs: z.array(packResultSchema),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const searchPacksNlOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type SearchPacksNlInput = z.infer<typeof searchPacksNlInputSchema>;
export type SearchPacksNlOutput = z.infer<typeof searchPacksNlOutputSchema>;
export type PackResult = z.infer<typeof packResultSchema>;
