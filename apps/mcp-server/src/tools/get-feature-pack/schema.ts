import { z } from 'zod';

/**
 * Input schema for `coodra__get_feature_pack` (§24.4).
 *
 * `projectSlug` is the single-namespace feature-pack slug (per
 * decisions-log 2026-04-24 12:15 "feature_packs is
 * single-namespace-by-slug"). `filePath` is optional — when
 * supplied, the handler resolves the deepest pack in the inheritance
 * chain whose `sourceFiles` globs match the path. Unmatched /
 * omitted → fall back to the slug's own pack.
 */
export const getFeaturePackInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be at most 128 characters')
      .describe('Feature-pack slug (same namespace as get_run_id — single global slug per §24.4).'),
    filePath: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe('Optional path to resolve against `sourceFiles` globs; deepest match wins.'),
  })
  .strict()
  .describe('Input for coodra__get_feature_pack.');

/**
 * Wire shape of a single FeaturePack in the output. Mirrors the
 * internal `FeaturePackStore` return (metadata + content) with
 * `updatedAt` serialised as an ISO-8601 string rather than a
 * `Date`, so the JSON wire format is lossless through
 * `JSON.stringify`.
 */
const featurePackMetadataSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    parentSlug: z.string().nullable(),
    isActive: z.boolean(),
    checksum: z.string().min(1),
    updatedAt: z.string().datetime().describe('ISO 8601 timestamp of the feature_packs row.'),
  })
  .strict();

const featurePackContentSchema = z
  .object({
    spec: z.string(),
    implementation: z.string(),
    techstack: z.string(),
    sourceFiles: z.array(z.string()).describe('Per-pack sourceFiles globs from meta.json.'),
  })
  .strict();

export const featurePackShapeSchema = z
  .object({
    metadata: featurePackMetadataSchema,
    content: featurePackContentSchema,
  })
  .strict();

/**
 * Output schema — soft-failure canonical shape per
 * `essentialsforclaude/09-common-patterns.md §9.1.2`: every failure
 * branch carries both `error` and `howToFix`. Module 07+ sub-feature-
 * packs will populate `subPack`; Module 02 always returns `null`
 * (decisions-log 2026-04-24 15:00 — `subPack` is the M07-reserved
 * slot for folder-nested sub-packs, a different scoping axis than
 * inheritance).
 */
const successBranch = z
  .object({
    ok: z.literal(true),
    pack: featurePackShapeSchema,
    subPack: z.null().describe('Reserved for Module 07+ folder-nested sub-packs. Always null in Module 02.'),
    inherited: z
      .array(featurePackShapeSchema)
      .describe('Ancestor chain of pack, root-first, NOT including pack itself.'),
  })
  .strict();

const packNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('pack_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const cycleBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('feature_pack_cycle'),
    chain: z.array(z.string().min(1)).describe('The cyclic parentSlug sequence, e.g. ["a","b","c","a"].'),
    howToFix: z.string().min(1),
  })
  .strict();

export const getFeaturePackOutputSchema = z.union([successBranch, packNotFoundBranch, cycleBranch]);

export type GetFeaturePackInput = z.infer<typeof getFeaturePackInputSchema>;
export type GetFeaturePackOutput = z.infer<typeof getFeaturePackOutputSchema>;
export type FeaturePackShape = z.infer<typeof featurePackShapeSchema>;
