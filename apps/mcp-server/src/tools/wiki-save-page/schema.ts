import { WIKI_ID_RE, WIKI_LIMITS, wikiPageContentSchema } from '@coodra/shared/wiki';
import { z } from 'zod';

/**
 * Input schema for `coodra__wiki_save_page` (Module 10, pass 2).
 *
 * Authors one page of a previously-saved wiki structure. `wikiId` is the
 * value `wiki_save_structure` returned; `pageId` is one of its
 * `pendingPageIds`; `content` is the `WikiPageContent` — Markdown body
 * (which may embed ```mermaid fenced diagrams) plus optional source
 * citations. Re-authoring a page overwrites it (idempotent).
 */
export const wikiSavePageInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
    wikiId: z.string().min(1, 'wikiId is required').max(256).describe('The wikiId returned by wiki_save_structure.'),
    pageId: z
      .string()
      .min(1, 'pageId is required')
      .max(WIKI_LIMITS.MAX_ID)
      .regex(WIKI_ID_RE, 'pageId must be kebab-case')
      .describe('Page id to author — one of the structure’s page ids.'),
    content: wikiPageContentSchema.describe('Markdown body (may include ```mermaid blocks) + optional citations.'),
  })
  .strict()
  .describe('Input for coodra__wiki_save_page.');

const successBranch = z
  .object({
    ok: z.literal(true),
    wikiId: z.string().min(1),
    pageId: z.string().min(1),
    state: z.literal('authored'),
    authoredCount: z.number().int().nonnegative().describe('Pages authored so far in this wiki.'),
    pageCount: z.number().int().nonnegative().describe('Total pages in the wiki structure.'),
    remaining: z.number().int().nonnegative().describe('Pages still pending — author the rest, then you are done.'),
  })
  .strict();

const runNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('run_not_found'), howToFix: z.string().min(1) })
  .strict();

const authRequiredBranch = z
  .object({ ok: z.literal(false), error: z.literal('auth_required'), howToFix: z.string().min(1) })
  .strict();

const wikiNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('wiki_not_found'), howToFix: z.string().min(1) })
  .strict();

const pageNotInStructureBranch = z
  .object({ ok: z.literal(false), error: z.literal('page_not_in_structure'), howToFix: z.string().min(1) })
  .strict();

// z.union (not discriminatedUnion): multiple `ok: false` branches share
// the discriminator, which Zod v4 rejects for discriminatedUnion.
export const wikiSavePageOutputSchema = z.union([
  successBranch,
  runNotFoundBranch,
  authRequiredBranch,
  wikiNotFoundBranch,
  pageNotInStructureBranch,
]);

export type WikiSavePageInput = z.infer<typeof wikiSavePageInputSchema>;
export type WikiSavePageOutput = z.infer<typeof wikiSavePageOutputSchema>;
