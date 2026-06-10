import { z } from 'zod';

/**
 * Input schema for `coodra__wiki_status` (Module 10).
 *
 * Read-only progress probe for a wiki: which pages are still pending.
 * Lets the agent resume the content pass (after an interruption, or in a
 * later session) without re-planning the structure. `wikiId` is the value
 * `wiki_save_structure` returned.
 */
export const wikiStatusInputSchema = z
  .object({
    wikiId: z.string().min(1, 'wikiId is required').max(256).describe('The wikiId returned by wiki_save_structure.'),
  })
  .strict()
  .describe('Input for coodra__wiki_status.');

const pageStatusSchema = z
  .object({
    pageId: z.string().min(1),
    state: z.enum(['pending', 'authored']),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    wikiId: z.string().min(1),
    slug: z.string().min(1),
    title: z.string(),
    mode: z.string(),
    pageCount: z.number().int().nonnegative(),
    authoredCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    pendingPageIds: z.array(z.string()).describe('Page ids still to author via wiki_save_page.'),
    pages: z.array(pageStatusSchema).describe('Every page with its authoring state.'),
  })
  .strict();

const wikiNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('wiki_not_found'), howToFix: z.string().min(1) })
  .strict();

export const wikiStatusOutputSchema = z.discriminatedUnion('ok', [successBranch, wikiNotFoundBranch]);

export type WikiStatusInput = z.infer<typeof wikiStatusInputSchema>;
export type WikiStatusOutput = z.infer<typeof wikiStatusOutputSchema>;
