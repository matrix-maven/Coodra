import { z } from 'zod';

/**
 * Input + output schemas for `coodra__wiki_ask` (COOD-30).
 *
 * The cloud-facing counterpart to `coodra wiki ask` (CLI): that command
 * only ever reads the calling machine's own local Markdown mirror or
 * local SQLite fallback (`packages/cli/src/commands/wiki.ts`), so a
 * team-mode teammate who never ran `coodra wiki build` on their own
 * laptop gets `no_wiki` even when a project's wiki genuinely exists in
 * the shared store. This tool reads through whichever `DbHandle` the
 * MCP server is connected to — local SQLite in solo mode, shared
 * Postgres in team mode — the same mode-abstraction `search_packs_nl`
 * and `query_decisions` already have.
 *
 * Unlike `search_packs_nl`'s thin excerpts (there is a separate
 * `read_context_pack` for full content), each result here includes the
 * page's full `contentMarkdown`: a remote/team-mode caller has no local
 * file to open the way the CLI's human-facing output assumes, and no
 * `wiki_get_page`-style tool exists yet to fetch it separately. `limit`
 * defaults low (5) because of that — this is a heavier response than
 * `search_packs_nl`'s ranked-excerpt list.
 */

const MAX_QUESTION_LEN = 2000 as const;
const DEFAULT_LIMIT = 5 as const;
const MAX_LIMIT = 20 as const;

export const wikiAskInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be at most 128 characters')
      .describe('Project slug — same single-namespace convention as get_run_id.'),
    question: z
      .string()
      .min(1, 'question is required')
      .max(MAX_QUESTION_LEN, `question must be at most ${MAX_QUESTION_LEN} characters`)
      .describe('Natural-language question about this codebase.'),
    slug: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Which wiki to search (default: the project slug, matching `coodra wiki build`'s default)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max ranked pages to return, each with full page content (default ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}) — ` +
          'kept low relative to search_packs_nl because every result includes the full contentMarkdown, not just an excerpt.',
      ),
  })
  .strict()
  .describe('Input for coodra__wiki_ask.');

const wikiAskResultSchema = z
  .object({
    pageId: z.string().min(1),
    title: z.string(),
    /** Relevance score from the shared wiki scorer — higher is more relevant. Not comparable across questions or wikis. */
    score: z.number(),
    /** Short snippet around the best keyword match — for quick scanning, not a substitute for contentMarkdown. */
    excerpt: z.string(),
    /** Full page body. Read this to answer the question — the excerpt alone is not enough. */
    contentMarkdown: z.string(),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    wikiId: z.string().min(1),
    slug: z.string().min(1),
    results: z.array(wikiAskResultSchema),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const wikiNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('wiki_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

// `z.union`, not `discriminatedUnion` — two distinct ok:false branches
// share the same `ok` literal, so `ok` alone can't discriminate between
// them (see get-recipe/schema.ts for the same convention).
export const wikiAskOutputSchema = z.union([successBranch, projectNotFoundBranch, wikiNotFoundBranch]);

export type WikiAskInput = z.infer<typeof wikiAskInputSchema>;
export type WikiAskOutput = z.infer<typeof wikiAskOutputSchema>;
export type WikiAskResultRow = z.infer<typeof wikiAskResultSchema>;
