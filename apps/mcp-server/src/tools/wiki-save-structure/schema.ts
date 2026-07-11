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
 *
 * Replace guard (field fix 2026-07-12): a re-plan against a wiki that
 * already has AUTHORED pages soft-fails with `wiki_exists` unless
 * `replace: true` is passed — two agents defaulting to the project slug
 * used to silently wipe each other's authored wikis (the re-plan is a
 * DELETE-then-INSERT). A pending-only skeleton (nothing authored yet) is
 * still replaced freely so an agent can iterate on its plan mid-flow.
 */
export const wikiSaveStructureInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
    slug: z
      .string()
      .min(1, 'slug is required')
      .max(WIKI_LIMITS.MAX_ID)
      .regex(WIKI_ID_RE, 'slug must be kebab-case (lowercase, digits, hyphens)')
      .describe(
        'Wiki slug within the project (kebab-case; usually the project slug). Re-using it re-plans the wiki (requires replace: true once pages are authored).',
      ),
    structure: wikiStructureSchema.describe(
      'The full WikiStructure: title/description/mode + the page+section hierarchy.',
    ),
    replace: z
      .boolean()
      .optional()
      .describe(
        'Set true to replace an existing wiki that already has AUTHORED pages (a destructive re-plan: every authored page is deleted). Without it, the call soft-fails with wiki_exists to protect authored work. Only pass it when the user explicitly asked for a re-plan/refresh.',
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

const wikiExistsBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('wiki_exists'),
    /** The existing wiki the caller may resume via wiki_status. */
    wikiId: z.string().min(1),
    authoredCount: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    howToFix: z.string().min(1),
  })
  .strict();

// z.union (not discriminatedUnion): Zod v4 rejects a discriminated union
// with multiple members sharing the same `ok: false` discriminator. Same
// shape as save_context_pack's multi-soft-failure output.
export const wikiSaveStructureOutputSchema = z.union([
  successBranch,
  runNotFoundBranch,
  authRequiredBranch,
  wikiExistsBranch,
]);

export type WikiSaveStructureInput = z.infer<typeof wikiSaveStructureInputSchema>;
export type WikiSaveStructureOutput = z.infer<typeof wikiSaveStructureOutputSchema>;
