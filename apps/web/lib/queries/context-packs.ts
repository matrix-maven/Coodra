import {
  type ContextPackDetailRow,
  type ContextPackRow,
  type DbHandle,
  getContextPackById,
  type ListContextPacksFilter,
  listContextPacksForProject,
} from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/context-packs.ts` — server-only wrappers around
 * the context-pack helpers added to `packages/db/src/runs-admin.ts`
 * for M04 Phase 2 S7 (FP↔CP linkage panel) + S9 (CP list/detail).
 *
 * Note on FP↔CP linkage scope: the schema does NOT carry a
 * `feature_pack_id` foreign key on `context_packs` today (per
 * `apps/mcp-server/src/tools/save-context-pack/schema.ts:32` —
 * featurePackId is accepted in the input schema but discarded at
 * write). For now both S7 and S9 list at the *project* grain;
 * filtering further by FP requires the schema extension that lands
 * with M05's NL Assembly. The S7 surface labels this honestly.
 */

export async function listContextPacks(filter: ListContextPacksFilter & { db?: DbHandle }): Promise<ContextPackRow[]> {
  const handle = filter.db ?? createWebDb();
  return listContextPacksForProject(handle, filter);
}

export async function getContextPack(id: string, db?: DbHandle): Promise<ContextPackDetailRow | null> {
  const handle = db ?? createWebDb();
  return getContextPackById(handle, id);
}
