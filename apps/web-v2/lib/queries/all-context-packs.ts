import {
  type ContextPackWithProject,
  type DbHandle,
  type ListAllContextPacksFilter,
  listAllContextPacks,
} from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/all-context-packs.ts` — workspace-level
 * Context Pack listing. The existing `lib/queries/context-packs.ts`
 * is project-scoped (used by the `/projects/[slug]/...` surfaces);
 * this one is workspace-wide for `/context-packs`.
 */

export async function listAllPacks(
  filter: ListAllContextPacksFilter & { db?: DbHandle } = {},
): Promise<ContextPackWithProject[]> {
  const handle = filter.db ?? createWebDb();
  return listAllContextPacks(handle, filter);
}
