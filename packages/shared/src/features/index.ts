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

export { parseFeatureMd, renderFeatureMd } from './parse.js';
export { FRONTMATTER_SCHEMA, FEATURE_SLUG_RE, validateFrontmatterQuality } from './schema.js';
export { featuresRoot, walkFeatures, readFeatureRow } from './walk.js';
export { generateFeaturesIndex, renderIndexMd } from './index-gen.js';
export type {
  FeatureFile,
  FeatureFrontmatter,
  FeatureIndex,
  FeatureIndexEntry,
  FeatureMaturity,
  FeatureRow,
  ParsedFeatureMd,
} from './types.js';
export type { GenerateIndexOptions, GenerateIndexResult } from './index-gen.js';
