import { createHash } from 'node:crypto';

import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createSeedFeaturePacksFromGraphHandler, type SeedFeaturePacksFromGraphHandlerDeps } from './handler.js';
import {
  type SeedFeaturePacksFromGraphInput,
  seedFeaturePacksFromGraphInputSchema,
  seedFeaturePacksFromGraphOutputSchema,
} from './schema.js';

/**
 * Registration factory for `coodra__seed_feature_packs_from_graph`
 * (Module 09, track 9B / phase G2).
 *
 * Factory-shaped because the handler closes over a `DbHandle` for the
 * `projects` lookup + the `feature_packs` upsert.
 *
 * The idempotency-key surface is `mutating` — the tool writes
 * `feature_packs` rows. The registry does not dedupe on this key;
 * dedupe is enforced by the `feature_packs.slug` UNIQUE constraint via
 * the handler's ON CONFLICT DO UPDATE. The key mirrors the request
 * shape so a retry surfaces the same trace id in the log.
 *
 * §24.3 description anatomy is enforced by
 * `@coodra/shared/test-utils::assertManifestDescriptionValid` in the
 * unit suite — do NOT hand-roll per-tool anatomy assertions.
 */

const seedFeaturePacksFromGraphIdempotencyKey: IdempotencyKeyBuilder<SeedFeaturePacksFromGraphInput> = (
  input,
  _ctx,
) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const communityIds = Array.isArray(input?.communities)
    ? input.communities.map((c) => (typeof c?.communityId === 'string' ? c.communityId : '')).join(',')
    : '';
  const hash = createHash('sha256').update(communityIds).digest('hex').slice(0, 32);
  return {
    kind: 'mutating',
    key: `seed_fp:${slug}:${hash}`.slice(0, 200),
  };
};

export function createSeedFeaturePacksFromGraphToolRegistration(
  deps: SeedFeaturePacksFromGraphHandlerDeps,
): ToolRegistration<typeof seedFeaturePacksFromGraphInputSchema, typeof seedFeaturePacksFromGraphOutputSchema> {
  return {
    name: 'seed_feature_packs_from_graph',
    title: 'Coodra: seed_feature_packs_from_graph',
    description:
      'Call this to bootstrap Feature Packs for a project from its code graph. After fetching the Leiden ' +
      "community breakdown from the Graphify MCP server — each community's label, god-node symbols, and member " +
      'files — pass the communities here. The tool creates one DRAFT Feature Pack per community; drafts stay ' +
      'hidden from agents until a tech lead reviews and activates them. Each pack embeds the community structure ' +
      '(key symbols and member files) in its spec. Idempotent per community slug — re-seeding updates the draft ' +
      'and never clobbers a pack a lead has already published. Returns { ok: true, seeded, count } on success, ' +
      'or a project_not_found soft-failure.',
    inputSchema: seedFeaturePacksFromGraphInputSchema,
    outputSchema: seedFeaturePacksFromGraphOutputSchema,
    idempotencyKey: seedFeaturePacksFromGraphIdempotencyKey,
    handler: createSeedFeaturePacksFromGraphHandler(deps),
  };
}
