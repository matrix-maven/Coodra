import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createSaveContextPackHandler, type SaveContextPackHandlerDeps } from './handler.js';
import { type SaveContextPackInput, saveContextPackInputSchema, saveContextPackOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__save_context_pack` (§24.4).
 *
 * Factory shape because the handler closes over a `DbHandle` for the
 * `runs` lookup + UPDATE. The context_packs write itself goes through
 * `ctx.contextPack` (already on `ContextDeps`). Description is §24.4
 * verbatim (92 words — inside the 120-word hard cap).
 */

const saveContextPackIdempotencyKey: IdempotencyKeyBuilder<SaveContextPackInput> = (input, _ctx) => {
  // Append-only redesign (2026-08-05): a run can now legitimately hold
  // several Context Packs, so keying on runId alone is NOT a dedupe
  // mechanism for those distinct saves — this key is only ever
  // forwarded into PerCallContext/policy evaluation as a log/audit
  // correlator (confirmed via tool-registry.ts; the framework itself
  // never uses it for caching or DB dedupe). Real retry-safety (an
  // identical re-call not duplicating a row) is enforced in
  // context-pack.ts::write() via an exact (title, content) match, not
  // here — grouping every save attempt on a run under one coarse
  // correlator key is intentional, not a leftover of the old
  // one-row-per-run constraint this key's format predates.
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
    title: 'Coodra: save_context_pack',
    description:
      'Call this whenever you finish a coherent unit of work, not just once at session end — a run can hold several of these ' +
      '(e.g. a sync, then unrelated ad hoc work). Write a narrative recap: what was built, decided, and left open. ' +
      'This is the canonical record the next session reads. The bridge auto-saves a structured digest as a crash fallback — your call overrides it. ' +
      'Include `meta` with decisionIds, affectedFiles, testStatus, openTodos when applicable. ' +
      'Pass `workPackSlug` to link a Work Pack, `alsoLinkWorkPackSlugs` for related packs, `kind`/`importance` to classify this pack. ' +
      'Returns { contextPackId, savedAt, contentExcerpt, source, status } — status is "created" | "idempotent_hit" | "upgraded_from_bridge_auto". ' +
      'Soft-failure: run_not_found.',
    inputSchema: saveContextPackInputSchema,
    outputSchema: saveContextPackOutputSchema,
    idempotencyKey: saveContextPackIdempotencyKey,
    handler: createSaveContextPackHandler(deps),
  };
}
