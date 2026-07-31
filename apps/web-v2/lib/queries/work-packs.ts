import { listWorkPacksDetailed, type WorkPackListItem } from '@coodra/db';

import { createWebDb } from '@/lib/db';

export interface WorkPackGroup {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly projectName: string;
  readonly packs: WorkPackListItem[];
}

export async function listWorkPacksByProject(): Promise<WorkPackGroup[]> {
  const db = createWebDb();
  const packs = await listWorkPacksDetailed(db);
  const groups = new Map<string, WorkPackGroup>();
  for (const pack of packs) {
    const existing = groups.get(pack.projectId);
    if (existing !== undefined) {
      existing.packs.push(pack);
      continue;
    }
    groups.set(pack.projectId, {
      projectId: pack.projectId,
      projectSlug: pack.projectSlug,
      projectName: pack.projectName,
      packs: [pack],
    });
  }
  return [...groups.values()];
}
