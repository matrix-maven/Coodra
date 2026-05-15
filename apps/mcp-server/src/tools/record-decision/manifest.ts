import { createHash } from 'node:crypto';

import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createRecordDecisionHandler, type RecordDecisionHandlerDeps } from './handler.js';
import { type RecordDecisionInput, recordDecisionInputSchema, recordDecisionOutputSchema } from './schema.js';

/**
 * Registration factory for `coodra__record_decision` (§24.4, S13).
 *
 * Factory-shaped because the handler closes over a `DbHandle` for the
 * `runs` lookup + `decisions` INSERT (see `handler.ts` docblock).
 *
 * The registry's idempotency-key surface is mutating — the key
 * mirrors the handler's dedupe shape
 * (`dec:{runId}:{sha256(description).slice(0,32)}`) so the request log
 * shows the same key an agent's retry would emit. The registry itself
 * does not dedupe on this key; dedupe is enforced by the
 * `decisions.idempotency_key` UNIQUE constraint inside the handler.
 * Mismatch would hide retries in the log.
 *
 * §24.3 description anatomy (five-part recipe + 40–80 word band) is
 * enforced by `@coodra/shared/test-utils::assertManifestDescriptionValid`
 * in the unit suite — do NOT hand-roll per-tool anatomy assertions.
 */

const recordDecisionIdempotencyKey: IdempotencyKeyBuilder<RecordDecisionInput> = (input, _ctx) => {
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'probe';
  const description = typeof input?.description === 'string' ? input.description : '';
  const hash = createHash('sha256').update(description).digest('hex').slice(0, 32);
  return {
    kind: 'mutating',
    key: `dec:${runId}:${hash}`.slice(0, 200),
  };
};

export function createRecordDecisionToolRegistration(
  deps: RecordDecisionHandlerDeps,
): ToolRegistration<typeof recordDecisionInputSchema, typeof recordDecisionOutputSchema> {
  return {
    name: 'record_decision',
    title: 'Coodra: record_decision',
    description:
      'Call this the moment you make a design or implementation decision — picking a library over alternatives, designing an API shape, deciding NOT to do something. ' +
      'Future sessions consult this table and SessionStart auto-injects the most recent decisions; silent contradictions are the failure mode this tool prevents. ' +
      'Pass `context` (what triggered the decision), `impact` (modules affected), `confidence` (high|medium|low), and `reversible` (can it be undone cheaply) when known. ' +
      'Idempotent on (runId, description) — the same description re-recorded returns the original decisionId with created:false; new metadata on the retry is discarded. ' +
      'Returns { ok: true, decisionId, createdAt, created } on success. Soft-failure: run_not_found.',
    inputSchema: recordDecisionInputSchema,
    outputSchema: recordDecisionOutputSchema,
    idempotencyKey: recordDecisionIdempotencyKey,
    handler: createRecordDecisionHandler(deps),
  };
}
