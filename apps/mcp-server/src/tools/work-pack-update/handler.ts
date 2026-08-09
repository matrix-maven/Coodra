import type { DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import { updateWorkPack } from '../../lib/work-pack-store.js';
import type { WorkPackUpdateInput, WorkPackUpdateOutput } from './schema.js';

const handlerLogger = createLogger('mcp-server.tool.work_pack_update');

export interface WorkPackUpdateHandlerDeps {
  readonly db: DbHandle;
}

export function createWorkPackUpdateHandler(deps: WorkPackUpdateHandlerDeps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createWorkPackUpdateHandler requires deps');
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWorkPackUpdateHandler: deps.db must be a DbHandle');
  }

  return async function workPackUpdateHandler(
    input: WorkPackUpdateInput,
    ctx: ToolContext,
  ): Promise<WorkPackUpdateOutput> {
    const result = await updateWorkPack(deps.db, {
      runId: input.runId,
      slug: input.slug,
      patch: input.patch,
      relationships: input.relationships,
      changeReason: input.changeReason,
      now: ctx.now(),
    });
    if (typeof result !== 'string') return result;

    handlerLogger.info(
      { event: 'work_pack_update_not_found', error: result, runId: input.runId, slug: input.slug, sessionId: ctx.sessionId },
      'work_pack_update: runId or Work Pack slug unknown; returning soft failure',
    );
    if (result === 'run_not_found') {
      return {
        ok: false,
        error: 'run_not_found',
        howToFix: 'Call get_run_id for the current project first, then retry work_pack_update with that runId.',
      };
    }
    return {
      ok: false,
      error: 'work_pack_not_found',
      howToFix:
        'Call get_run_id for the current project and work_pack_status to confirm the slug exists, then retry work_pack_update.',
    };
  };
}
