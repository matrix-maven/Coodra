import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createQueryDecisionsHandler, type QueryDecisionsHandlerDeps } from './handler.js';
import { type QueryDecisionsInput, queryDecisionsInputSchema, queryDecisionsOutputSchema } from './schema.js';

/**
 * Registration factory for `contextos__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + the decisions SELECT joined to runs.
 * Read-only tool: idempotency key is kind `readonly`. Distinct
 * (projectSlug, query, runId, limit) tuples emit distinct log keys
 * so retries can be correlated without collapsing two distinct reads.
 *
 * §24.3 description anatomy (five-part recipe + 40–120 word band) is
 * enforced by `@coodra/contextos-shared/test-utils::assertManifestDescriptionValid`
 * in the unit suite.
 */

const queryDecisionsIdempotencyKey: IdempotencyKeyBuilder<QueryDecisionsInput> = (input, _ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const query = typeof input?.query === 'string' && input.query.length > 0 ? input.query : 'any';
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'any';
  const limit = typeof input?.limit === 'number' ? input.limit : 10;
  return {
    kind: 'readonly',
    key: `readonly:query_decisions:${slug}:${query}:${runId}:${limit}`.slice(0, 200),
  };
};

export function createQueryDecisionsToolRegistration(
  deps: QueryDecisionsHandlerDeps,
): ToolRegistration<typeof queryDecisionsInputSchema, typeof queryDecisionsOutputSchema> {
  return {
    name: 'query_decisions',
    title: 'ContextOS: query_decisions',
    description:
      'Call this when the user asks "what did we decide about X?" or "any prior decisions on Y?" or you need to reconcile your current approach against decisions recorded in earlier sessions. ' +
      'Returns the chronological (most-recent-first) list of decisions logged via record_decision for this project, optionally narrowed by a substring against description+rationale or by an exact runId. ' +
      "Use alongside query_run_history when answering 'what happened recently' and as the cross-session memory primitive that search_packs_nl cannot serve until M05 ships embeddings. " +
      'Returns { ok: true, decisions: [...] } on success (possibly empty), or { ok: false, error: "project_not_found", howToFix } if the projectSlug is not registered. ' +
      'Default limit 10, max 200.',
    inputSchema: queryDecisionsInputSchema,
    outputSchema: queryDecisionsOutputSchema,
    idempotencyKey: queryDecisionsIdempotencyKey,
    handler: createQueryDecisionsHandler(deps),
  };
}
