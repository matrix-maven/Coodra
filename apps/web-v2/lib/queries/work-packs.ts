import { getWorkPackDetail, listWorkPacksDetailed, type WorkPackDetail, type WorkPackListItem } from '@coodra/db';

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

export async function getWorkPackProject(projectSlug: string): Promise<WorkPackGroup | null> {
  const groups = await listWorkPacksByProject();
  return groups.find((group) => group.projectSlug === projectSlug) ?? null;
}

export async function getWorkPackDetailBySlug(
  projectSlug: string,
  workPackSlug: string,
): Promise<WorkPackDetail | null> {
  const db = createWebDb();
  const packs = await listWorkPacksDetailed(db);
  const pack = packs.find((item) => item.projectSlug === projectSlug && item.slug === workPackSlug);
  if (pack === undefined) return null;
  return getWorkPackDetail(db, pack.id);
}
