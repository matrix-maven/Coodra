import { z } from 'zod';

const MAX_LIMIT = 200 as const;
const DEFAULT_LIMIT = 20 as const;

export const queryDecisionsByFileInputSchema = z
  .object({
    projectSlug: z.string().min(1, 'projectSlug is required').max(256),
    filePath: z
      .string()
      .min(1, 'filePath is required')
      .max(1024)
      .describe(
        'File path or module string to resolve through Graphify blast radius when graph artifacts are available; otherwise exact file target lookup.',
      ),
    activeOnly: z.boolean().default(true).describe('When true, exclude decisions superseded by a newer decision edge.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict()
  .describe('Input for coodra__query_decisions_by_file.');

const decisionForFileSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    description: z.string(),
    rationale: z.string(),
    createdAt: z.string().datetime(),
    supersededBy: z.string().min(1).nullable(),
  })
  .strict();

const blastRadiusSchema = z
  .object({
    /**
     * COOD-81: "present AND fresh enough to trust". A graph past the
     * drift budget reports false and returns only the exact-file
     * target — correct-but-narrow beats confidently wrong.
     */
    graphAvailable: z.boolean(),
    depth: z.number().int().min(1).max(1),
    rootNodeIds: z.array(z.string()),
    graphNodeTargets: z.array(z.string()),
    fileTargets: z.array(z.string()),
    /** Commit the graph was built at, from `graph.json`. */
    builtAtCommit: z.string().nullable(),
    /** Commits from that build to HEAD; null when not computable. */
    commitsBehind: z.number().int().nonnegative().nullable(),
    /** Files changed over that range; null when not computable. */
    filesChanged: z.number().int().nonnegative().nullable(),
    /**
     * `fresh` — measured, within budget. `stale` — measured, over
     * budget, topology withheld. `unknown` — drift not measurable (no
     * recorded commit, non-git checkout, or commit lost to a rebase);
     * the graph is still served, flagged rather than relabelled.
     */
    staleness: z.enum(['fresh', 'stale', 'unknown']),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    filePath: z.string(),
    blastRadius: blastRadiusSchema,
    decisions: z.array(decisionForFileSchema),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const queryDecisionsByFileOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type QueryDecisionsByFileInput = z.infer<typeof queryDecisionsByFileInputSchema>;
export type QueryDecisionsByFileOutput = z.infer<typeof queryDecisionsByFileOutputSchema>;
