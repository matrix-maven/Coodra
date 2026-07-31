/**
 * @coodra/shared/features — public surface.
 *
 * Single import site for the features module. Every consumer
 * (CLI, hooks-bridge, mcp-server, web-v2) goes through this barrel
 * so the on-disk format and the parsed shape stay in lock-step.
 *
 * What lives here vs. what lives in the consumers:
 *
 *   - SHARED: parsing, validation, filesystem walk, index generation,
 *     rendering. Anything that operates on the canonical feature.md
 *     shape regardless of which surface owns the call.
 *
 *   - CONSUMER-SPECIFIC: scaffolding (CLI), bridge SessionStart wiring,
 *     MCP tool handlers, server-action mutations, React UI. These
 *     import the primitives below and orchestrate them.
 */

export type { GenerateIndexOptions, GenerateIndexResult } from './index-gen.js';
export { generateFeaturesIndex, renderIndexMd } from './index-gen.js';
export { parseFeatureMd, renderFeatureMd } from './parse.js';
export { FEATURE_SLUG_RE, FRONTMATTER_SCHEMA, validateFrontmatterQuality } from './schema.js';
export type {
  FeatureFile,
  FeatureFrontmatter,
  FeatureIndex,
  FeatureIndexEntry,
  FeatureMaturity,
  FeatureRow,
  ParsedFeatureMd,
} from './types.js';
export {
  featuresRoot,
  LEGACY_FEATURE_MD_NAME,
  LEGACY_FEATURES_DIR_NAME,
  RECIPE_MD_NAME,
  RECIPES_DIR_NAME,
  readFeatureRow,
  recipesDirCandidates,
  recipesRoot,
  SKILLS_DIR_NAME,
  skillsDirCandidates,
  skillsRoot,
  walkFeatures,
} from './walk.js';
