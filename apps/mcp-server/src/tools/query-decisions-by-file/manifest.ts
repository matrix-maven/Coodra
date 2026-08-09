import type { IdempotencyKeyBuilder } from '../../framework/idempotency.js';
import type { ToolRegistration } from '../../framework/tool-registry.js';

import { createQueryDecisionsByFileHandler, type QueryDecisionsByFileHandlerDeps } from './handler.js';
import {
  type QueryDecisionsByFileInput,
  queryDecisionsByFileInputSchema,
  queryDecisionsByFileOutputSchema,
} from './schema.js';

const queryDecisionsByFileIdempotencyKey: IdempotencyKeyBuilder<QueryDecisionsByFileInput> = (input, _ctx) => {
  const slug = typeof input?.projectSlug === 'string' && input.projectSlug.length > 0 ? input.projectSlug : 'probe';
  const file = typeof input?.filePath === 'string' && input.filePath.length > 0 ? input.filePath : 'any';
  const activeOnly = input?.activeOnly === false ? 'all' : 'active';
  const limit = typeof input?.limit === 'number' ? input.limit : 20;
  return {
    kind: 'readonly',
    key: `readonly:query_decisions_by_file:${slug}:${file}:${activeOnly}:${limit}`.slice(0, 200),
  };
};

export function createQueryDecisionsByFileToolRegistration(
  deps: QueryDecisionsByFileHandlerDeps,
): ToolRegistration<typeof queryDecisionsByFileInputSchema, typeof queryDecisionsByFileOutputSchema> {
  return {
    name: 'query_decisions_by_file',
    title: 'Coodra: query_decisions_by_file',
    description:
      'Call this when you need to answer which architectural or implementation decisions explicitly affected a file or module before editing or reverting it. ' +
      'It expands the requested file through the project Graphify code graph when available, then reads matching COOD-58 file and graph_node decision_edges. Defaults to active decisions only and can include superseded history with activeOnly:false. ' +
      'Returns matching decisions with supersededBy annotations, or project_not_found.',
    inputSchema: queryDecisionsByFileInputSchema,
    outputSchema: queryDecisionsByFileOutputSchema,
    idempotencyKey: queryDecisionsByFileIdempotencyKey,
    handler: createQueryDecisionsByFileHandler(deps),
  };
}
