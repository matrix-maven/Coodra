import type { DbHandle } from '@coodra/db';

import type { ToolContext } from '../../framework/tool-context.js';
import { selectRunProjectId } from '../../lib/wiki-store.js';
import { listWorkPackStatus } from '../../lib/work-pack-store.js';
import type { WorkPackStatusInput, WorkPackStatusOutput } from './schema.js';

export interface WorkPackStatusHandlerDeps {
  readonly db: DbHandle;
}

export function createWorkPackStatusHandler(deps: WorkPackStatusHandlerDeps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('createWorkPackStatusHandler requires deps');
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createWorkPackStatusHandler: deps.db must be a DbHandle');
  }

  return async function workPackStatusHandler(
    input: WorkPackStatusInput,
    _ctx: ToolContext,
  ): Promise<WorkPackStatusOutput> {
    const projectId = input.runId === undefined ? null : await selectRunProjectId(deps.db, input.runId);
    if (input.runId !== undefined && projectId === null) {
      return {
        ok: false,
        error: 'run_not_found',
        howToFix: 'Call get_run_id for the current project first, then retry work_pack_status with that runId.',
      };
    }
    const packs = await listWorkPackStatus(deps.db, projectId, input.query);
    return { ok: true, projectId, packs: [...packs] };
  };
}
