import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';
import { createWorkPackUpsertHandler, type WorkPackUpsertHandlerDeps } from './handler.js';
import { type WorkPackUpsertInput, workPackUpsertInputSchema, workPackUpsertOutputSchema } from './schema.js';

const workPackUpsertIdempotencyKey: IdempotencyKeyBuilder<WorkPackUpsertInput> = (input) => {
  const runId = typeof input?.runId === 'string' && input.runId.length > 0 ? input.runId : 'unknown';
  const slug = typeof input?.slug === 'string' && input.slug.length > 0 ? input.slug : 'none';
  const externalKey =
    typeof input?.source?.externalKey === 'string' && input.source.externalKey.length > 0
      ? input.source.externalKey
      : 'unknown';
  return {
    kind: 'mutating',
    key: `work_pack_upsert:${runId}:${slug}:${externalKey}`.slice(0, 200),
  };
};

export function createWorkPackUpsertToolRegistration(
  deps: WorkPackUpsertHandlerDeps,
): ToolRegistration<typeof workPackUpsertInputSchema, typeof workPackUpsertOutputSchema> {
  return {
    name: 'work_pack_upsert',
    title: 'Coodra: work_pack_upsert',
    description:
      'Persist an agent-mediated Jira import as a Coodra Work Pack. Use this after the active agent has read the ' +
      'issue through Atlassian Rovo MCP; do not call this as a Jira client and do not put Atlassian credentials in ' +
      'Coodra. The tool upserts external_work_items, work_packs, link and relationship rows, records a sync event, ' +
      'and mirrors files under .coodra/work-packs/<slug>/ when the project cwd is known. Include bounded related ' +
      'tasks/subtasks/blockers so later agent sessions can resume the implementation map intelligently.',
    inputSchema: workPackUpsertInputSchema,
    outputSchema: workPackUpsertOutputSchema,
    idempotencyKey: workPackUpsertIdempotencyKey,
    handler: createWorkPackUpsertHandler(deps),
  };
}
