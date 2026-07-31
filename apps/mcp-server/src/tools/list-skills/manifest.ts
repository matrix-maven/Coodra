import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createListFeaturesHandler, type ListFeaturesHandlerDeps } from './handler.js';
import { type ListFeaturesInput, listFeaturesInputSchema, listFeaturesOutputSchema } from './schema.js';

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

export function createListSkillsToolRegistration(
  deps: ListFeaturesHandlerDeps,
): ToolRegistration<typeof listFeaturesInputSchema, typeof listFeaturesOutputSchema> {
  return {
    name: 'list_skills',
    title: 'Coodra: list_skills',
    description:
      // §24.3 hard cap: ≤ 800 chars (manifest-e2e locks it — a QA-sweep run
      // caught the previous wording at 857).
      'Call when you need to discover available SKILLS for this project — atomic, reusable recipes fetched on ' +
      "demand when a user prompt matches a skill's trigger description (the Anthropic Skills pattern). Distinct " +
      'from Work Packs: Work Packs are issue-bound implementation records; skills are pull-based. ' +
      'Returns { ok: true, features: [{slug, description, whenNotToUse, maturity, fileCount, ...}] } sorted by ' +
      'slug (the `features` key is kept for back-compat), OR soft-failure with project_not_found / ' +
      'project_cwd_unknown / features_dir_missing. Call `get_skill(slug)` only for skills whose triggers match ' +
      'the task — never load every skill blindly. Re-run on unrecognised topics. (Former name `list_features` ' +
      'still works as an alias.)',
    inputSchema: listFeaturesInputSchema,
    outputSchema: listFeaturesOutputSchema,
    idempotencyKey: listFeaturesIdempotencyKey,
    handler: createListFeaturesHandler(deps),
  };
}
