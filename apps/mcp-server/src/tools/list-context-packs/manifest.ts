import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createListContextPacksHandler, type ListContextPacksHandlerDeps } from './handler.js';
import {
  type ListContextPacksInput,
  listContextPacksInputSchema,
  listContextPacksOutputSchema,
} from './schema.js';

/**
 * Registration factory for `coodra__list_context_packs` (M05 §5.1).
 *
 * Read-only tool — idempotency key kind `readonly`. Different
 * (slug, limit, cursor) tuples emit distinct log keys.
 *
 * §24.3 description anatomy enforced by
 * `@coodra/shared/test-utils::assertManifestDescriptionValid`.
 */

const listContextPacksIdempotencyKey: IdempotencyKeyBuilder<ListContextPacksInput> = (input, _ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const cursor = typeof input?.cursor === 'string' ? input.cursor.slice(0, 32) : 'first';
  const limit = typeof input?.limit === 'number' ? input.limit : 20;
  return {
    kind: 'readonly',
    key: `readonly:list_context_packs:${slug}:${cursor}:${limit}`.slice(0, 200),
  };
};

export function createListContextPacksToolRegistration(
  deps: ListContextPacksHandlerDeps,
): ToolRegistration<typeof listContextPacksInputSchema, typeof listContextPacksOutputSchema> {
  return {
    name: 'list_context_packs',
    title: 'Coodra: list_context_packs',
    description:
      'Call this when you need to enumerate Context Packs for a project — answering "what work has happened here recently" or "have we tackled this kind of problem before". ' +
      'Returns a paginated list ordered by save time newest-first, with title, excerpt, runId, savedAt, and source. ' +
      'Use the `source` field to distinguish agent-authored narratives ("agent") from bridge auto-summaries ("bridge_auto") — prefer the former when reading detail. ' +
      'Pair with `read_context_pack` to load full content for any candidate. Pagination via opaque `cursor` from the prior response\'s `nextCursor`. ' +
      'Soft-failures: project_not_found, malformed_cursor.',
    inputSchema: listContextPacksInputSchema,
    outputSchema: listContextPacksOutputSchema,
    idempotencyKey: listContextPacksIdempotencyKey,
    handler: createListContextPacksHandler(deps),
  };
}
