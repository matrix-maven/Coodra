import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createReadContextPackHandler, type ReadContextPackHandlerDeps } from './handler.js';
import {
  type ReadContextPackInput,
  readContextPackInputSchema,
  readContextPackOutputSchema,
} from './schema.js';

/**
 * Registration factory for `coodra__read_context_pack` (M05 §5.2).
 *
 * Read-only tool — idempotency key kind `readonly`.
 * §24.3 description anatomy enforced by
 * `@coodra/shared/test-utils::assertManifestDescriptionValid`.
 */

const readContextPackIdempotencyKey: IdempotencyKeyBuilder<ReadContextPackInput> = (input, _ctx) => {
  const id =
    typeof input?.packId === 'string' && input.packId.length > 0
      ? `p:${input.packId}`
      : typeof input?.runId === 'string' && input.runId.length > 0
        ? `r:${input.runId}`
        : 'probe';
  const excerptOnly = input?.excerptOnly === true ? '1' : '0';
  return {
    kind: 'readonly',
    key: `readonly:read_context_pack:${id}:e${excerptOnly}`.slice(0, 200),
  };
};

export function createReadContextPackToolRegistration(
  deps: ReadContextPackHandlerDeps,
): ToolRegistration<typeof readContextPackInputSchema, typeof readContextPackOutputSchema> {
  return {
    name: 'read_context_pack',
    title: 'Coodra: read_context_pack',
    description:
      'Call this after `list_context_packs` or `search_packs_nl` to load the full body of a single Context Pack. ' +
      'Provide exactly one of `packId` or `runId`. Returns title, content, save time, source (agent | bridge_auto), the agent-supplied `meta` (decisionIds, affectedFiles, testStatus, openTodos), and all decisions recorded during that run with their structured fields. ' +
      'Set `excerptOnly: true` when budget is tight — returns the 500-char preview instead of the full body. ' +
      'Returns `pack_too_large` for packs over 200KB; retry with `excerptOnly: true`. Returns `found: false` when no row matches.',
    inputSchema: readContextPackInputSchema,
    outputSchema: readContextPackOutputSchema,
    idempotencyKey: readContextPackIdempotencyKey,
    handler: createReadContextPackHandler(deps),
  };
}
