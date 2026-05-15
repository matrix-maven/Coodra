import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createQueryRunHistoryHandler, type QueryRunHistoryHandlerDeps } from './handler.js';
import { type QueryRunHistoryInput, queryRunHistoryInputSchema, queryRunHistoryOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__query_run_history` (§24.4, S12).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * projects-slug resolution + runs SELECT with `context_packs` LEFT JOIN.
 * Read-only tool: idempotency key is kind `readonly`. Registry skips
 * DB-backed dedupe but logs the key for correlation. Different
 * (status, limit) combos on the same project emit distinct log keys
 * so retries can be correlated without collapsing two distinct reads.
 *
 * §24.3 description anatomy (five-part recipe + 40–80 word band) is
 * enforced by `@coodra/shared/test-utils::assertManifestDescriptionValid`
 * in the unit suite.
 */

const queryRunHistoryIdempotencyKey: IdempotencyKeyBuilder<QueryRunHistoryInput> = (input, _ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const status = typeof input?.status === 'string' && input.status.length > 0 ? input.status : 'any';
  const limit = typeof input?.limit === 'number' ? input.limit : 10;
  return {
    kind: 'readonly',
    key: `readonly:query_run_history:${slug}:${status}:${limit}`.slice(0, 200),
  };
};

export function createQueryRunHistoryToolRegistration(
  deps: QueryRunHistoryHandlerDeps,
): ToolRegistration<typeof queryRunHistoryInputSchema, typeof queryRunHistoryOutputSchema> {
  return {
    name: 'query_run_history',
    title: 'Coodra: query_run_history',
    description:
      'Call this when you need to understand recent work on this project — which runs have been executed, their status, associated PRs or JIRA issues, and the context-pack title of each completed run. ' +
      'Returns a chronological (most-recent-first) list of runs with metadata. ' +
      "Use alongside search_packs_nl when answering 'what happened recently?' questions, and at session start to see whether there is an in_progress run to resume. " +
      'Returns { ok: true, runs: [...] } on success (possibly empty), or { ok: false, error: "project_not_found", howToFix } if the projectSlug is not registered. ' +
      'Default limit 10, max 200.',
    inputSchema: queryRunHistoryInputSchema,
    outputSchema: queryRunHistoryOutputSchema,
    idempotencyKey: queryRunHistoryIdempotencyKey,
    handler: createQueryRunHistoryHandler(deps),
  };
}
