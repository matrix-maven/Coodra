import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createQueryDecisionsHandler, type QueryDecisionsHandlerDeps } from './handler.js';
import { type QueryDecisionsInput, queryDecisionsInputSchema, queryDecisionsOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__query_decisions` (Slice 4 — 2026-05-03 audit).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + the decisions SELECT joined to runs.
 * Read-only tool: idempotency key is kind `readonly`. Distinct
 * (projectSlug, query, runId, limit) tuples emit distinct log keys
 * so retries can be correlated without collapsing two distinct reads.
 *
 * §24.3 description anatomy (five-part recipe + 40–120 word band) is
 * enforced by `@coodra/shared/test-utils::assertManifestDescriptionValid`
 * in the unit suite.
 */

const queryDecisionsIdempotencyKey: IdempotencyKeyBuilder<QueryDecisionsInput> = (input, _ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const query = typeof input?.query === 'string' && input.query.length > 0 ? input.query : 'any';
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'any';
  const workPackId = typeof input?.workPackId === 'string' && input.workPackId.length > 0 ? input.workPackId : 'any';
  const includeRelated = input?.includeRelated === true ? 'rel' : 'norel';
  const limit = typeof input?.limit === 'number' ? input.limit : 10;
  return {
    kind: 'readonly',
    key: `readonly:query_decisions:${slug}:${query}:${runId}:${workPackId}:${includeRelated}:${limit}`.slice(0, 200),
  };
};

export function createQueryDecisionsToolRegistration(
  deps: QueryDecisionsHandlerDeps,
): ToolRegistration<typeof queryDecisionsInputSchema, typeof queryDecisionsOutputSchema> {
  return {
    name: 'query_decisions',
    title: 'Coodra: query_decisions',
    description:
      'Call this when the user asks "what did we decide about X?", you need to reconcile your current approach against earlier decisions, or you are composing a sync-back summary for an external tracker/PR. ' +
      'Returns decisions logged via record_decision for this project — most-recent-first by default, or BM25-ranked best-match-first when query is set (matched against description+rationale) — optionally narrowed by runId, issueRef, or workPackId (every run tied to that pack, plus any explicitly tagged via workPackSlugs). ' +
      'Add includeRelated:true to also pull decisions from packs related to workPackId. ' +
      'Returns { ok: true, decisions: [...] } (possibly empty), or { ok: false, error: "project_not_found", howToFix }. Default limit 10, max 200.',
    inputSchema: queryDecisionsInputSchema,
    outputSchema: queryDecisionsOutputSchema,
    idempotencyKey: queryDecisionsIdempotencyKey,
    handler: createQueryDecisionsHandler(deps),
  };
}
