import { z } from 'zod';

/**
 * Input + output schemas for `coodra__get_feature`.
 *
 *   - `{ ok: true, feature: { slug, frontmatter, body, files: [...] } }`
 *
 *   - `{ ok: false, error: 'project_not_found',     howToFix }`
 *   - `{ ok: false, error: 'project_cwd_unknown',   howToFix }`
 *   - `{ ok: false, error: 'feature_not_found',     howToFix }`
 *
 * `files` is metadata only (paths + bytes + mtime). Bodies of
 * supporting files are NOT included here — the agent calls
 * `get_feature_file(slug, path)` for those, gated by extension /
 * size limits.
 */

export const getFeatureInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be ≤ 128 chars'),
    slug: z
      .string()
      .min(1, 'slug is required')
      .max(64, 'slug must be ≤ 64 chars')
      .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters, digits, hyphens or underscores'),
  })
  .strict()
  .describe('Input for coodra__get_feature.');

const featureFileSchema = z
  .object({
    path: z.string().min(1).describe('POSIX-style path relative to the feature directory.'),
    bytes: z.number().int().nonnegative(),
    modifiedAt: z.string().datetime(),
  })
  .strict();

const featureFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    whenNotToUse: z.string().nullable(),
    maturity: z.enum(['draft', 'beta', 'stable', 'deprecated']),
    tags: z.array(z.string()),
    owners: z.array(z.string()),
  })
  .strict();

const successBranch = z
  .object({
    ok: z.literal(true),
    slug: z.string().min(1),
    frontmatter: featureFrontmatterSchema,
    body: z.string().describe('Body of feature.md after the closing frontmatter fence.'),
    files: z
      .array(featureFileSchema)
      .describe('Supporting files in this feature directory (excludes feature.md).'),
    warnings: z
      .array(z.string())
      .describe('Validation warnings — non-fatal hints to surface to the user via the web UI.'),
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

const featureNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('feature_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

// `z.union` (not discriminatedUnion) — see list-features/schema.ts.
export const getFeatureOutputSchema = z.union([
  successBranch,
  projectNotFoundBranch,
  projectCwdUnknownBranch,
  featureNotFoundBranch,
]);

export type GetFeatureInput = z.infer<typeof getFeatureInputSchema>;
export type GetFeatureOutput = z.infer<typeof getFeatureOutputSchema>;
