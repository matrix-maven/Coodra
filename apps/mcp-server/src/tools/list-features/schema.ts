import { z } from 'zod';

/**
 * Input + output schemas for `coodra__list_features`.
 *
 * Output is a discriminated union per `09-common-patterns §9.1.2`:
 *
 *   - `{ ok: true, features: [...], featuresRoot, projectSlug }`
 *
 *   - `{ ok: false, error: 'project_not_found',     howToFix }`
 *   - `{ ok: false, error: 'project_cwd_unknown',   howToFix }`
 *   - `{ ok: false, error: 'features_dir_missing',  howToFix }`
 *
 * Every soft-failure branch carries `error` + `howToFix` (the
 * load-bearing two-field floor from §9.1.2). Callers must check
 * BOTH `response.ok` and `response.data.ok`.
 */

export const listFeaturesInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be ≤ 128 chars')
      .describe('Project slug (matches `projects.slug` and the on-disk `docs/features/` directory).'),
  })
  .strict()
  .describe('Input for coodra__list_features.');

const featureEntrySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    whenNotToUse: z.string().nullable(),
    maturity: z.enum(['draft', 'beta', 'stable', 'deprecated']),
    tags: z.array(z.string()),
    owners: z.array(z.string()),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    lastUpdatedAt: z.string().datetime(),
    hasWarnings: z.boolean(),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    projectSlug: z.string().min(1),
    featuresRoot: z.string().min(1).describe('Absolute path to <projectCwd>/docs/features/.'),
    features: z
      .array(featureEntrySchema)
      .describe(
        'Lightweight skill-style index. The agent reads description + whenNotToUse to decide whether to call get_feature for the body.',
      ),
  })
  .strict();

const projectNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const projectCwdUnknownBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('project_cwd_unknown'),
    howToFix: z.string().min(1),
  })
  .strict();

const featuresDirMissingBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('features_dir_missing'),
    howToFix: z.string().min(1),
  })
  .strict();

// Plain union (not discriminatedUnion) because Zod requires unique
// discriminator values per branch; here the three soft-failure
// branches all share `ok: z.literal(false)` and discriminate on
// `error`. The `get_feature_pack` tool uses the same `z.union` shape
// for the same reason — see its schema.ts for the established pattern.
export const listFeaturesOutputSchema = z.union([
  successBranch,
  projectNotFoundBranch,
  projectCwdUnknownBranch,
  featuresDirMissingBranch,
]);

export type ListFeaturesInput = z.infer<typeof listFeaturesInputSchema>;
export type ListFeaturesOutput = z.infer<typeof listFeaturesOutputSchema>;
