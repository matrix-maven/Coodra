import { z } from 'zod';

/**
 * Input + output schemas for `coodra__search_packs_nl`.
 *
 * Module 05 reshape (2026-05-08): the embedding-supplied semantic-KNN
 * path was removed alongside the abandoned Python NL Assembly service.
 *
 * BM25 full-text search (2026-08-03): search is now ranked, not just
 * keyword-matched — backed by SQLite FTS5 (`context_packs_fts`,
 * `packages/db/drizzle/sqlite/0024_fts_search.sql`) / Postgres generated
 * `tsvector` (`context_packs.search_vector`,
 * `packages/db/drizzle/postgres/0026_fts_search.sql`) over title +
 * content_excerpt, replacing the earlier LIKE-substring implementation.
 * `score` (previously always `null`) is now the real bm25()/ts_rank()
 * value; results are ordered best-match-first. Vector/semantic search
 * remains out of scope — `context_packs.summaryEmbedding`/
 * `context_packs_vec` stay unused infrastructure for a later phase.
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
      .describe('Project slug — same single-namespace convention as get_run_id.'),
    query: z
      .string()
      .min(1, 'query is required')
      .max(MAX_QUERY_LEN, `query must be at most ${MAX_QUERY_LEN} characters`)
      .describe(
        'Keyword(s) to BM25-rank against title + content_excerpt. Every word must appear (implicit AND); for semantic exploration call list_context_packs and reason over titles instead.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max results (default 50, capped at ${MAX_LIMIT}). Ordered by relevance (bm25/ts_rank), best match first.`,
      ),
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
    /** Relevance score, higher = more relevant, normalized consistently across dialects (SQLite's bm25() is natively negative-lower-is-better; negated in the handler so this field always means "higher is better," matching Postgres ts_rank()'s native convention). */
    score: z.number().nullable(),
    savedAt: z.string().datetime(),
    runId: z.string().min(1),
    /** Provenance — 'agent' rows are canonical narratives; 'bridge_auto' rows are structured digests. */
    source: z.enum(['agent', 'bridge_auto']),
    /** True when this pack's meta.decisionIds includes a decision superseded by a COOD-58 decision edge. */
    superseded: z.boolean(),
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
