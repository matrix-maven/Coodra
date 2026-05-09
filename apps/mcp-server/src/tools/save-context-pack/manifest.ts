import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createSaveContextPackHandler, type SaveContextPackHandlerDeps } from './handler.js';
import { type SaveContextPackInput, saveContextPackInputSchema, saveContextPackOutputSchema } from './schema.js';

/**
 * Registration factory for `contextos__save_context_pack` (§24.4).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * `runs` lookup + UPDATE. The context_packs write itself goes through
 * `ctx.contextPack` (already on `ContextDeps`). Description is §24.4
 * verbatim (92 words — inside the 120-word hard cap).
 */

const saveContextPackIdempotencyKey: IdempotencyKeyBuilder<SaveContextPackInput> = (input, _ctx) => {
  // Per S7c/S10 rule: key on runId alone — the store dedupes per-
  // runId (append-only), so same-runId-different-content retries
  // collapse to the same logical operation. Log correlator only;
  // not used for DB dedupe (the context_packs unique index on
  // runId is the enforcer).
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'probe';
  return {
    kind: 'mutating',
    key: `save_context_pack:${runId}`.slice(0, 200),
  };
};

export function createSaveContextPackToolRegistration(
  deps: SaveContextPackHandlerDeps,
): ToolRegistration<typeof saveContextPackInputSchema, typeof saveContextPackOutputSchema> {
  return {
    name: 'save_context_pack',
    title: 'ContextOS: save_context_pack',
    description:
      'Call this at session end before signaling exit. Write a narrative recap synthesizing what was built, what was decided, what is still open. ' +
      'This is the canonical record the next session reads. The bridge auto-saves a structured event digest as a fallback for crashed sessions — your call overrides it and is preferred. ' +
      'Include `meta` with decisionIds, affectedFiles, testStatus, openTodos when applicable so the next session has structured handles into the narrative. ' +
      'Returns { contextPackId, savedAt, contentExcerpt, source, status } on success — `status` is "created" | "idempotent_hit" | "upgraded_from_bridge_auto". ' +
      'Soft-failure: run_not_found.',
    inputSchema: saveContextPackInputSchema,
    outputSchema: saveContextPackOutputSchema,
    idempotencyKey: saveContextPackIdempotencyKey,
    handler: createSaveContextPackHandler(deps),
  };
}
