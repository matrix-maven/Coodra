import {
  type ContextPackDetailRow,
  type ContextPackRow,
  type DbHandle,
  getContextPackById,
  type ListContextPacksFilter,
  listContextPacksForProject,
} from '@coodra/db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/context-packs.ts` — server-only wrappers around
 * context-pack helpers. Context Packs are still listed at the project
 * grain; Work Pack ↔ Context Pack linking will be modeled explicitly
 * when that UI lands.
 */

export async function listContextPacks(filter: ListContextPacksFilter & { db?: DbHandle }): Promise<ContextPackRow[]> {
  const handle = filter.db ?? createWebDb();
  return listContextPacksForProject(handle, filter);
}

export async function getContextPack(id: string, db?: DbHandle): Promise<ContextPackDetailRow | null> {
  const handle = db ?? createWebDb();
  return getContextPackById(handle, id);
}
