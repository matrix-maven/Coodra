import { z } from 'zod';

/**
 * Input + output schemas for `coodra__list_context_packs` (M05 §5.1).
 *
 * Pagination via opaque cursor: base64 of `{lastCreatedAt, lastId}`
 * tuple. The handler validates the cursor's structural shape and falls
 * through to the project-not-found / malformed-cursor soft-failures
 * when the input doesn't decode. Cursor on `(created_at DESC, id DESC)`
 * keeps the scan stable across same-second ties.
 */

const MAX_LIMIT = 100 as const;
const DEFAULT_LIMIT = 20 as const;

export const listContextPacksInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be at most 128 characters'),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(`Max packs to return (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}).`),
    cursor: z
      .string()
      .optional()
      .describe('Opaque cursor from a prior call. Pass to fetch the next page.'),
  })
  .strict()
  .describe('Input for coodra__list_context_packs.');

const packRowSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    excerpt: z.string(),
    savedAt: z.string().datetime(),
    runId: z.string().min(1),
    source: z.enum(['agent', 'bridge_auto']),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    packs: z.array(packRowSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const malformedCursorBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('malformed_cursor'),
    howToFix: z.string().min(1),
  })
  .strict();

export const listContextPacksOutputSchema = z.union([successBranch, projectNotFoundBranch, malformedCursorBranch]);

export type ListContextPacksInput = z.infer<typeof listContextPacksInputSchema>;
export type ListContextPacksOutput = z.infer<typeof listContextPacksOutputSchema>;
export type ListContextPacksRow = z.infer<typeof packRowSchema>;
export const LIST_CONTEXT_PACKS_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const LIST_CONTEXT_PACKS_MAX_LIMIT = MAX_LIMIT;
