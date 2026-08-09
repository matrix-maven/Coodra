import { createHash } from 'node:crypto';

import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';
import { createWorkPackUpdateHandler, type WorkPackUpdateHandlerDeps } from './handler.js';
import { type WorkPackUpdateInput, workPackUpdateInputSchema, workPackUpdateOutputSchema } from './schema.js';

function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

const workPackUpdateIdempotencyKey: IdempotencyKeyBuilder<WorkPackUpdateInput> = (input) => {
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'unknown';
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'none';
  return {
    kind: 'mutating',
    key: `work_pack_update:${runId}:${slug}:${shortHash({
      patch: input?.patch ?? {},
      relationships: input?.relationships ?? null,
      changeReason: input?.changeReason ?? null,
    })}`.slice(0, 200),
  };
};

export function createWorkPackUpdateToolRegistration(
  deps: WorkPackUpdateHandlerDeps,
): ToolRegistration<typeof workPackUpdateInputSchema, typeof workPackUpdateOutputSchema> {
  return {
    name: 'work_pack_update',
    title: 'Coodra: work_pack_update',
    description:
      'Use this to deliberately revise an existing local Coodra Work Pack after import: scope, acceptance criteria, status, implementation notes, sync notes, metadata, or its relationship map. ' +
      'Unlike work_pack_upsert, this is a partial patch surface for local editorial changes and it does not call Jira, GitHub, or any provider. It marks linked external items local_ahead and records a pending sync event so the active agent can later update Jira through the provider MCP and then refresh Coodra with work_pack_upsert. ' +
      'Returns the changed fields, sync state, external link count, mirror directory, or a soft not-found failure.',
    inputSchema: workPackUpdateInputSchema,
    outputSchema: workPackUpdateOutputSchema,
    idempotencyKey: workPackUpdateIdempotencyKey,
    handler: createWorkPackUpdateHandler(deps),
  };
}
