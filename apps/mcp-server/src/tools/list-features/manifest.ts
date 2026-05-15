import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createListFeaturesHandler, type ListFeaturesHandlerDeps } from './handler.js';
import {
  type ListFeaturesInput,
  listFeaturesInputSchema,
  listFeaturesOutputSchema,
} from './schema.js';

/**
 * Registration factory for `coodra__list_features`.
 *
 * Read-only — idempotency kind is `read` so the registry doesn't dedupe
 * across separate calls (every list query gets a fresh roundtrip; the
 * cost is bounded by the indexer's idempotent regen-on-read).
 *
 * The description follows the §24.3 five-part recipe (imperative
 * trigger / return shape / why / when-NOT / hand-off). The agent uses
 * the returned descriptions to decide which features to load via
 * `coodra__get_feature`; that's the central skill-pattern handshake.
 */

const listFeaturesIdempotencyKey: IdempotencyKeyBuilder<ListFeaturesInput> = (input, ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'unknown';
  return {
    kind: 'readonly',
    key: `list_features:${slug}:${ctx.sessionId}`.slice(0, 200),
  };
};

export function createListFeaturesToolRegistration(
  deps: ListFeaturesHandlerDeps,
): ToolRegistration<typeof listFeaturesInputSchema, typeof listFeaturesOutputSchema> {
  return {
    name: 'list_features',
    title: 'Coodra: list_features',
    description:
      'Call when you need to discover available SKILLS for this project — atomic, reusable recipes the agent fetches ' +
      'on demand when a user prompt matches a feature\'s trigger description (the Anthropic Skills pattern). ' +
      'Distinct from `get_feature_pack`: Feature Packs are MODULE blueprints (push, loaded at SessionStart). ' +
      'Features are SKILLS (pull, loaded on trigger match). Returns { ok: true, features: [{slug, description, ' +
      'whenNotToUse, maturity, fileCount, ...}] } sorted by slug, OR soft-failure with project_not_found / ' +
      'project_cwd_unknown / features_dir_missing. Read each description, then call `get_feature(slug)` only for ' +
      'features whose triggers match the current task — never load every feature blindly. Re-run when the user ' +
      'mentions a topic you don\'t recognise.',
    inputSchema: listFeaturesInputSchema,
    outputSchema: listFeaturesOutputSchema,
    idempotencyKey: listFeaturesIdempotencyKey,
    handler: createListFeaturesHandler(deps),
  };
}
