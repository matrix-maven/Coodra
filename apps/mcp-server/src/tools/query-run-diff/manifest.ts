import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createQueryRunDiffHandler, type QueryRunDiffHandlerDeps } from './handler.js';
import { type QueryRunDiffInput, queryRunDiffInputSchema, queryRunDiffOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__query_run_diff` (Module 06).
 *
 * Read-only tool — idempotency key kind `readonly`. Reads the run_diffs
 * row written by the hooks-bridge SessionEnd runner and returns it (or
 * a discriminated-union soft-failure) to the agent. §24.3 description
 * anatomy enforced by `assertManifestDescriptionValid`.
 */

const queryRunDiffIdempotencyKey: IdempotencyKeyBuilder<QueryRunDiffInput> = (input, _ctx) => {
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'probe';
  return {
    kind: 'readonly',
    key: `readonly:query_run_diff:${runId}`.slice(0, 200),
  };
};

export function createQueryRunDiffToolRegistration(
  deps: QueryRunDiffHandlerDeps,
): ToolRegistration<typeof queryRunDiffInputSchema, typeof queryRunDiffOutputSchema> {
  return {
    name: 'query_run_diff',
    title: 'Coodra: query_run_diff',
    description:
      'Call this when assembling a session recap and you need to know which functions, classes, imports, and tests changed during a run — i.e. exactly what edits the agent made on disk. ' +
      'Returns the unified `git diff` (scoped to files the agent touched in Edit/Write/MultiEdit calls) plus per-file metadata (additions, deletions, status). ' +
      'Prefer this over re-reading every edited file when writing save_context_pack. ' +
      'Soft-failures: run_not_found, analysis_pending (SessionEnd not yet fired), no_base_sha (non-git project), no_edits_in_run, git_diff_failed.',
    inputSchema: queryRunDiffInputSchema,
    outputSchema: queryRunDiffOutputSchema,
    idempotencyKey: queryRunDiffIdempotencyKey,
    handler: createQueryRunDiffHandler(deps),
  };
}
