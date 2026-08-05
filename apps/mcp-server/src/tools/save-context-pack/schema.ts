import { z } from 'zod';

/**
 * Input schema for `coodra__save_context_pack`.
 *
 * Module 05 reshape (2026-05-08): adds optional `meta` object for
 * agent-curated metadata (decisionIds, affectedFiles, testStatus,
 * openTodos). Removed nothing from the prior surface — strictly
 * additive, all new fields are optional.
 *
 * `projectId` is NOT in the caller's input; the handler resolves it
 * from `runs.projectId` via the `runId`. This matches §24.4 and
 * keeps the agent-facing surface small.
 *
 * Size caps are defensive — oversize → Zod validation failure →
 * registry's generic `invalid_input` envelope. Not a structured
 * soft-failure: invalid input is a client bug, not a user-recoverable
 * state.
 */

const MAX_TITLE = 512 as const;
const MAX_CONTENT = 1_048_576 as const; // 1 MiB in JS string length.
const MAX_META_ARRAY = 100 as const;
const MAX_META_STRING = 512 as const;

const metaSchema = z
  .object({
    /** Decisions (by id) that materially support this pack. May reference cross-run decisions. */
    decisionIds: z.array(z.string().min(1).max(MAX_META_STRING)).max(MAX_META_ARRAY).optional(),
    /** Curated highlight of files the agent considers important — not exhaustive. */
    affectedFiles: z.array(z.string().min(1).max(MAX_META_STRING)).max(MAX_META_ARRAY).optional(),
    /** Self-reported test outcome at the moment of save. Not validated against real test runs. */
    testStatus: z.enum(['pass', 'fail', 'skip', 'unknown']).optional(),
    /** Remaining work the next session should pick up. */
    openTodos: z.array(z.string().min(1).max(MAX_META_STRING)).max(MAX_META_ARRAY).optional(),
  })
  .strict();

export const saveContextPackInputSchema = z
  .object({
    runId: z.string().min(1, 'runId is required').max(256),
    title: z.string().min(1, 'title is required').max(MAX_TITLE, `title must be at most ${MAX_TITLE} characters`),
    content: z
      .string()
      .min(1, 'content is required')
      .max(MAX_CONTENT, `content must be at most ${MAX_CONTENT} characters (~1 MiB)`),
    meta: metaSchema.optional(),
    workPackSlug: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'workPackSlug must be kebab-case')
      .optional()
      .describe('Optional Work Pack slug to link this Context Pack and run to, for example cood-10.'),
    /**
     * coodra-work redesign, round 2. Additive to `workPackSlug` — link
     * this Context Pack to further Work Pack(s) too, e.g. when the
     * session's recap is also directly relevant to a related pack.
     * Does not affect which pack `workPackSlug` binds the run to.
     */
    alsoLinkWorkPackSlugs: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case'),
      )
      .max(10)
      .optional(),
    /**
     * Append-only redesign (2026-08-05). Soft-governed — a free string,
     * not a hard enum, so a future kind doesn't require a Coodra code
     * change (same tradeoff already accepted for work_pack_upsert's
     * packType). Recommended: 'sync' | 'work_start' |
     * 'implementation_recap' | 'audit_findings' | 'final_recap'.
     * Deliberately provider-neutral — 'sync', not 'jira_sync'; which
     * external provider a sync came from lives on the linked Work
     * Pack's own source.provider, not here.
     */
    kind: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Optional classification for this pack. Soft-governed, not a hard enum — recommended values: 'sync', " +
          "'work_start', 'implementation_recap', 'audit_findings', 'final_recap'. Provider-neutral: which " +
          'external tool a sync came from belongs on the linked Work Pack, not here.',
      ),
    /** Soft-governed. Recommended: 'high' | 'medium' | 'low'. */
    importance: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("Optional priority signal for this pack. Soft-governed — recommended values: 'high', 'medium', 'low'."),
  })
  .strict()
  .describe('Input for coodra__save_context_pack.');

/**
 * Output schema — discriminated union on `ok` per §9.1.2 canonical
 * soft-failure shape. Success now includes `source` ('agent' or
 * 'bridge_auto') and `status` ('created' | 'idempotent_hit' |
 * 'upgraded_from_bridge_auto') so the caller can tell apart the three
 * outcomes without re-querying.
 */
const successBranch = z
  .object({
    ok: z.literal(true),
    contextPackId: z.string().min(1),
    savedAt: z.string().datetime().describe('ISO 8601 timestamp the context_packs row was inserted.'),
    contentExcerpt: z.string(),
    source: z.enum(['agent', 'bridge_auto']),
    status: z.enum(['created', 'idempotent_hit', 'upgraded_from_bridge_auto']),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

/**
 * Phase G slice G.6 — auth_required soft-failure.
 *
 * Returned in team mode when no verified Clerk JWT is available on
 * this machine (no `~/.coodra/clerk-token.json`, or the token is
 * expired/tampered). The agent surfaces `howToFix` to the user, who
 * runs `coodra login` and retries.
 */
const authRequiredBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('auth_required'),
    howToFix: z.string().min(1),
  })
  .strict();

export const saveContextPackOutputSchema = z.union([successBranch, runNotFoundBranch, authRequiredBranch]);

export type SaveContextPackInput = z.infer<typeof saveContextPackInputSchema>;
export type SaveContextPackOutput = z.infer<typeof saveContextPackOutputSchema>;
export type SaveContextPackMeta = z.infer<typeof metaSchema>;
