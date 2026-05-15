import { z } from 'zod';

/**
 * Input + output schemas for `coodra__query_codebase_graph`.
 *
 * Module 05 reshape (2026-05-08): the "deferred to Module 05" notice
 * was removed. The agent does its own filtering by reasoning over
 * `nodes` + `edges`. `maxNodes` (default 1000) caps the returned
 * subgraph so agents don't OOM on huge graphs; exceeding it returns
 * a `graph_too_large` soft-failure with a remediation hint.
 *
 * Soft-failure shapes:
 *   - `project_not_found`           — projectSlug not registered
 *   - `codebase_graph_not_indexed`  — project exists but no graph.json
 *   - `graph_too_large`             — index has > maxNodes; narrow scope
 *
 * Empty results (index present, zero nodes — valid empty subgraph,
 * unreadable file, malformed JSON) → `{ ok: true, nodes: [], edges: [],
 * indexed: true }`. Not a soft-failure.
 */

const DEFAULT_MAX_NODES = 1000 as const;
const HARD_MAX_NODES = 10_000 as const;

export const queryCodebaseGraphInputSchema = z
  .object({
    projectSlug: z.string().min(1, 'projectSlug is required').max(256),
    query: z.string().min(1, 'query is required').max(2048),
    /**
     * Cap on the size of the returned subgraph. The handler returns
     * `graph_too_large` rather than truncating silently when the
     * underlying graph exceeds this — agents need the explicit
     * remediation prompt to narrow scope.
     */
    maxNodes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_NODES)
      .optional()
      .describe(`Max nodes to return (default ${DEFAULT_MAX_NODES}, hard cap ${HARD_MAX_NODES}).`),
  })
  .strict()
  .describe('Input for coodra__query_codebase_graph.');

const successBranch = z
  .object({
    ok: z.literal(true),
    nodes: z.array(z.unknown()),
    edges: z.array(z.unknown()),
    indexed: z.literal(true),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const codebaseGraphNotIndexedBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('codebase_graph_not_indexed'),
    howToFix: z.string().min(1),
  })
  .strict();

const graphTooLargeBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('graph_too_large'),
    nodeCount: z.number().int().nonnegative(),
    maxNodes: z.number().int().nonnegative(),
    howToFix: z.string().min(1),
  })
  .strict();

export const queryCodebaseGraphOutputSchema = z.union([
  successBranch,
  projectNotFoundBranch,
  codebaseGraphNotIndexedBranch,
  graphTooLargeBranch,
]);

export type QueryCodebaseGraphInput = z.infer<typeof queryCodebaseGraphInputSchema>;
export type QueryCodebaseGraphOutput = z.infer<typeof queryCodebaseGraphOutputSchema>;
export const QUERY_CODEBASE_GRAPH_DEFAULT_MAX_NODES = DEFAULT_MAX_NODES;
export const QUERY_CODEBASE_GRAPH_HARD_MAX_NODES = HARD_MAX_NODES;
