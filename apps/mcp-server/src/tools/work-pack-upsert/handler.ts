import type { DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { upsertWorkPack } from '../../lib/work-pack-store.js';
import type { WorkPackUpsertInput, WorkPackUpsertOutput } from './schema.js';

const handlerLogger = createLogger('mcp-server.tool.work_pack_upsert');

export interface WorkPackUpsertHandlerDeps {
  readonly db: DbHandle;
}

export function createWorkPackUpsertHandler(deps: WorkPackUpsertHandlerDeps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createWorkPackUpsertHandler requires deps');
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWorkPackUpsertHandler: deps.db must be a DbHandle');
  }

  return async function workPackUpsertHandler(
    input: WorkPackUpsertInput,
    ctx: ToolContext,
  ): Promise<WorkPackUpsertOutput> {
    const result = await upsertWorkPack(deps.db, {
      runId: input.runId,
      slug: input.slug,
      title: input.title,
      packType: input.packType,
      status: input.status,
      specMarkdown: input.specMarkdown,
      implementationMarkdown: input.implementationMarkdown,
      syncMarkdown: input.syncMarkdown,
      metadataJson: input.metadataJson ?? {},
      source: input.source,
      relationships: input.relationships ?? [],
      now: ctx.now(),
    });
    if (result === null) {
      handlerLogger.info(
        { event: 'work_pack_upsert_run_not_found', runId: input.runId, sessionId: ctx.sessionId },
        'work_pack_upsert: runId unknown; returning soft failure',
      );
      return {
        ok: false,
        error: 'run_not_found',
        howToFix: 'Call get_run_id for the current project first, then retry work_pack_upsert with that runId.',
      };
    }
    return result;
  };
}
