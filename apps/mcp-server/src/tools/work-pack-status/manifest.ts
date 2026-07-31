import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';
import { createWorkPackStatusHandler, type WorkPackStatusHandlerDeps } from './handler.js';
import { type WorkPackStatusInput, workPackStatusInputSchema, workPackStatusOutputSchema } from './schema.js';

const workPackStatusIdempotencyKey: IdempotencyKeyBuilder<WorkPackStatusInput> = (input) => ({
  kind: 'readonly',
  key: `readonly:work_pack_status:${input.runId ?? '*'}`.slice(0, 200),
});

export function createWorkPackStatusToolRegistration(
  deps: WorkPackStatusHandlerDeps,
): ToolRegistration<typeof workPackStatusInputSchema, typeof workPackStatusOutputSchema> {
  return {
    name: 'work_pack_status',
    title: 'Coodra: work_pack_status',
    description:
      'List Coodra Work Packs and their linked Jira status/sync state so an agent can resume issue-bound work. ' +
      'Pass runId to scope the read to the current project; omit it only for an operator-wide inspection. This is ' +
      'read-only and intentionally does not contact Jira. If the agent needs fresh Jira fields, it should call ' +
      'Atlassian Rovo MCP first, then call work_pack_upsert to persist the refreshed local Work Pack map.',
    inputSchema: workPackStatusInputSchema,
    outputSchema: workPackStatusOutputSchema,
    idempotencyKey: workPackStatusIdempotencyKey,
    handler: createWorkPackStatusHandler(deps),
  };
}
