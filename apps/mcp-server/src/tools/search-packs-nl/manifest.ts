import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createSearchPacksNlHandler, type SearchPacksNlHandlerDeps } from './handler.js';
import { type SearchPacksNlInput, searchPacksNlInputSchema, searchPacksNlOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__search_packs_nl`.
 *
 * BM25 full-text search (2026-08-03): description rewritten — this is now
 * real ranked search (bm25()/ts_rank()) over title + content_excerpt, not
 * LIKE-substring ordered by recency. See `handler.ts`'s top docblock.
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
      'Call this when the user asks "what was done before?", "has X been tried?", "remember when we...", or "what is the current state of Y?" — or when you are unsure whether prior work on a topic exists. ' +
      'BM25-ranked keyword search over Context Pack titles + excerpts. Every word in `query` must appear. Returns up to 50 matches, best match first via `score` (higher = more relevant). ' +
      'Use the `source` field to prefer agent-authored narratives ("agent") over bridge auto-summaries ("bridge_auto"). ' +
      'Returns { ok: true, packs: [...] }. Soft-failure: project_not_found.',
    inputSchema: searchPacksNlInputSchema,
    outputSchema: searchPacksNlOutputSchema,
    idempotencyKey: searchPacksNlIdempotencyKey,
    handler: createSearchPacksNlHandler(deps),
  };
}
