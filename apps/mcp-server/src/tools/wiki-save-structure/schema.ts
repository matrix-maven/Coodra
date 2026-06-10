import { WIKI_ID_RE, WIKI_LIMITS, wikiStructureSchema } from '@coodra/shared/wiki';
import { z } from 'zod';

/**
 * Input schema for `coodra__wiki_save_structure` (Module 10, pass 1).
 *
 * Persists the Deep Wiki structure the agent planned from the codebase
 * grounding bundle. `structure` is the canonical `WikiStructure` from
 * `@coodra/shared/wiki` — validated here (referential integrity of
 * parentId / relatedPageIds / section refs is enforced by the shared
 * schema's superRefine), so a malformed plan is rejected at the wire
 * boundary as `invalid_input` rather than landing a broken wiki.
 *
 * `runId` is the value from `get_run_id`; the handler resolves the
 * project from `runs.projectId`. `slug` keys the wiki within the project
 * (kebab-case; typically the project slug) so a re-plan replaces the same
 * wiki rather than spawning duplicates.
 */
export const wikiSaveStructureInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
    slug: z
      .string()
      .min(1, 'slug is required')
      .max(WIKI_LIMITS.MAX_ID)
      .regex(WIKI_ID_RE, 'slug must be kebab-case (lowercase, digits, hyphens)')
      .describe('Wiki slug within the project (kebab-case; usually the project slug). Re-using it replaces the wiki.'),
    structure: wikiStructureSchema.describe(
      'The full WikiStructure: title/description/mode + the page+section hierarchy.',
    ),
  })
  .strict()
  .describe('Input for coodra__wiki_save_structure.');

const successBranch = z
  .object({
    ok: z.literal(true),
    wikiId: z.string().min(1).describe('Server-assigned wiki id — pass this to wiki_save_page and wiki_status.'),
    slug: z.string().min(1),
    mode: z.enum(['comprehensive', 'concise']),
    pageCount: z.number().int().nonnegative().describe('Number of pages in the structure (all start state="pending").'),
    status: z
      .enum(['created', 'replaced'])
      .describe('"replaced" when an existing wiki for this (project, slug) was re-planned.'),
    pendingPageIds: z.array(z.string()).describe('Page ids to author next via wiki_save_page.'),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const authRequiredBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('auth_required'),
    howToFix: z.string().min(1),
  })
  .strict();

// z.union (not discriminatedUnion): Zod v4 rejects a discriminated union
// with multiple members sharing the same `ok: false` discriminator. Same
// shape as save_context_pack's multi-soft-failure output.
export const wikiSaveStructureOutputSchema = z.union([successBranch, runNotFoundBranch, authRequiredBranch]);

export type WikiSaveStructureInput = z.infer<typeof wikiSaveStructureInputSchema>;
export type WikiSaveStructureOutput = z.infer<typeof wikiSaveStructureOutputSchema>;
