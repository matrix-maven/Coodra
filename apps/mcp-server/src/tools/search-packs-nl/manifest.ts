import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createSearchPacksNlHandler, type SearchPacksNlHandlerDeps } from './handler.js';
import { type SearchPacksNlInput, searchPacksNlInputSchema, searchPacksNlOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__search_packs_nl`.
 *
 * Module 05 reshape (2026-05-08): description rewritten to match the
 * keyword-only LIKE search. The agent does relevance ranking after
 * reading candidates with `read_context_pack` — see
 * `docs/feature-packs/05-agent-driven-nl-assembly/spec.md` §5.3.
 *
 * §24.3 anatomy is enforced by
 * `@coodra/shared/test-utils::assertManifestDescriptionValid`.
 */

const searchPacksNlIdempotencyKey: IdempotencyKeyBuilder<SearchPacksNlInput> = (input, _ctx) => {
  // Readonly: the registry skips DB-backed dedupe but logs the key
  // for correlation. Different queries on the same project collide
  // after truncation — fine for log-correlation (not dedup-critical).
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const queryPrefix = typeof input?.query === 'string' ? input.query.slice(0, 60) : '';
  return {
    kind: 'readonly',
    key: `readonly:search_packs_nl:${slug}:${queryPrefix}`.slice(0, 200),
  };
};

export function createSearchPacksNlToolRegistration(
  deps: SearchPacksNlHandlerDeps,
): ToolRegistration<typeof searchPacksNlInputSchema, typeof searchPacksNlOutputSchema> {
  return {
    name: 'search_packs_nl',
    title: 'Coodra: search_packs_nl',
    description:
      'Call this when the user asks "what was done before?", "has X been tried?", or "what is the current state of Y?" — or when you are unsure whether prior work on a topic exists. ' +
      'Searches Context Pack titles, excerpts, and the first 2KB of body content by keyword. Returns up to 50 matches ordered by recency, not relevance. ' +
      'Use the `source` field to prefer agent-authored narratives ("agent") over bridge auto-summaries ("bridge_auto"). Apply your own relevance ranking after reading candidates with read_context_pack. ' +
      'Returns { ok: true, packs: [...] }. Soft-failure: project_not_found.',
    inputSchema: searchPacksNlInputSchema,
    outputSchema: searchPacksNlOutputSchema,
    idempotencyKey: searchPacksNlIdempotencyKey,
    handler: createSearchPacksNlHandler(deps),
  };
}
