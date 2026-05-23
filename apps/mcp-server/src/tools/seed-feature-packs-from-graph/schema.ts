import { z } from 'zod';

/**
 * Input + output schemas for `coodra__seed_feature_packs_from_graph`
 * (Module 09, track 9B / phase G2).
 *
 * The tool takes Leiden community data — fetched by the agent from the
 * external Graphify MCP server — and creates one DRAFT Feature Pack per
 * community. Drafts are hidden from agents (`feature_packs.status='draft'`)
 * until a tech lead reviews and activates them, so seeding can never push
 * unreviewed knowledge into a live session.
 *
 * Size caps are defensive: an oversized payload fails Zod validation and
 * surfaces through the registry's generic `invalid_input` envelope — a
 * caller bug, not a user-recoverable soft-failure.
 */

const MAX_COMMUNITIES = 100 as const;
const MAX_LABEL = 200 as const;
const MAX_GOD_NODES = 50 as const;
const MAX_GOD_NODE_LEN = 256 as const;
const MAX_FILES = 500 as const;
const MAX_FILE_LEN = 1024 as const;
const MAX_SUMMARY = 2048 as const;

const communitySchema = z
  .object({
    communityId: z
      .string()
      .min(1, 'communityId is required')
      .max(128)
      .describe("Graphify community identifier (the `community` value carried on that cluster's nodes)."),
    label: z
      .string()
      .min(1, 'label is required')
      .max(MAX_LABEL)
      .describe('Human-readable community name — becomes the draft pack title and slug suffix.'),
    godNodes: z
      .array(z.string().min(1).max(MAX_GOD_NODE_LEN))
      .max(MAX_GOD_NODES)
      .optional()
      .describe('High-degree "god node" symbols Graphify flagged for this community.'),
    memberFiles: z
      .array(z.string().min(1).max(MAX_FILE_LEN))
      .max(MAX_FILES)
      .optional()
      .describe('Source files that belong to this community.'),
    summary: z
      .string()
      .min(1)
      .max(MAX_SUMMARY)
      .optional()
      .describe('Optional one-paragraph summary of what this community does.'),
  })
  .strict();

export const seedFeaturePacksFromGraphInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128)
      .describe('The registered project (projects.slug) these communities belong to.'),
    communities: z
      .array(communitySchema)
      .min(1, 'at least one community is required')
      .max(MAX_COMMUNITIES, `communities must be at most ${MAX_COMMUNITIES} items`)
      .describe('Leiden communities fetched from the Graphify MCP server.'),
  })
  .strict()
  .describe('Input for coodra__seed_feature_packs_from_graph.');

/**
 * Output — discriminated union on `ok` per the §9.1.2 canonical
 * soft-failure shape. `created` is `true` when a brand-new draft pack
 * row was inserted, `false` when an existing pack of that slug was
 * updated in place (idempotent re-seed).
 */
const seededEntrySchema = z
  .object({
    slug: z.string().min(1).describe('The feature-pack slug created or updated for this community.'),
    communityId: z.string().min(1),
    created: z.boolean().describe('true = new draft pack inserted; false = existing pack updated in place.'),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    seeded: z.array(seededEntrySchema),
    count: z.number().int().nonnegative().describe('Number of communities seeded (== seeded.length).'),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const seedFeaturePacksFromGraphOutputSchema = z.union([successBranch, projectNotFoundBranch]);

export type Community = z.infer<typeof communitySchema>;
export type SeedFeaturePacksFromGraphInput = z.infer<typeof seedFeaturePacksFromGraphInputSchema>;
export type SeedFeaturePacksFromGraphOutput = z.infer<typeof seedFeaturePacksFromGraphOutputSchema>;
