import { z } from 'zod';

/**
 * Input + output schemas for `coodra__read_context_pack` (M05 §5.2).
 *
 * Caller supplies EITHER `packId` OR `runId` (Zod refine catches both /
 * neither). Output discriminated on `found`:
 *   - { ok: true, found: true, ... full pack + decisions[] }
 *   - { ok: true, found: false }                 (no row)
 *   - { ok: false, error: 'pack_too_large', ... } (content > 200KB)
 *
 * Decisions are hydrated inline in chronological order. M05 includes
 * the new structured fields (context, impact, confidence, reversible);
 * legacy decisions (pre-M05) have NULL for those.
 */

const MAX_CONTENT_BYTES = 200_000 as const;
const DEFAULT_DECISIONS_LIMIT = 50 as const;
const HARD_DECISIONS_LIMIT = 200 as const;

export const readContextPackInputSchema = z
  .object({
    packId: z.string().min(1).max(256).optional(),
    runId: z.string().min(1).max(256).optional(),
    decisionsLimit: z
      .number()
      .int()
      .positive()
      .max(HARD_DECISIONS_LIMIT)
      .optional()
      .describe(`Max decisions to hydrate (default ${DEFAULT_DECISIONS_LIMIT}, hard cap ${HARD_DECISIONS_LIMIT}).`),
    excerptOnly: z
      .boolean()
      .optional()
      .describe('When true, returns the 500-char excerpt instead of full content. Use to economise on context budget.'),
  })
  .strict()
  .refine((d) => (d.packId !== undefined) !== (d.runId !== undefined), {
    message: 'Provide exactly one of packId or runId.',
    path: ['packId'],
  })
  .describe('Input for coodra__read_context_pack.');

const decisionRowSchema = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    rationale: z.string(),
    alternatives: z.array(z.string()),
    context: z.string().nullable(),
    impact: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
    reversible: z.boolean().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

const foundBranch = z
  .object({
    ok: z.literal(true),
    found: z.literal(true),
    id: z.string().min(1),
    runId: z.string().min(1),
    title: z.string(),
    /** Either full content OR the 500-char excerpt depending on excerptOnly. */
    content: z.string(),
    excerptOnly: z.boolean(),
    savedAt: z.string().datetime(),
    source: z.enum(['agent', 'bridge_auto']),
    /** JSON-decoded meta (M05). Nullable when caller didn't supply on save. */
    meta: z
      .object({
        decisionIds: z.array(z.string()).optional(),
        affectedFiles: z.array(z.string()).optional(),
        testStatus: z.enum(['pass', 'fail', 'skip', 'unknown']).optional(),
        openTodos: z.array(z.string()).optional(),
      })
      .strict()
      .nullable(),
    decisions: z.array(decisionRowSchema),
  })
  .strict();

const notFoundBranch = z
  .object({
    ok: z.literal(true),
    found: z.literal(false),
  })
  .strict();

const tooLargeBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('pack_too_large'),
    contentBytes: z.number().int().nonnegative(),
    howToFix: z.string().min(1),
  })
  .strict();

const validationFailedBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('validation_failed'),
    howToFix: z.string().min(1),
  })
  .strict();

export const readContextPackOutputSchema = z.union([foundBranch, notFoundBranch, tooLargeBranch, validationFailedBranch]);

export type ReadContextPackInput = z.infer<typeof readContextPackInputSchema>;
export type ReadContextPackOutput = z.infer<typeof readContextPackOutputSchema>;
export const READ_CONTEXT_PACK_MAX_CONTENT_BYTES = MAX_CONTENT_BYTES;
export const READ_CONTEXT_PACK_DEFAULT_DECISIONS_LIMIT = DEFAULT_DECISIONS_LIMIT;
