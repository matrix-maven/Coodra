import {
  getProjectByIdentifier as getProjectByIdentifierDb,
  listProjects as listProjectsDb,
  type ProjectDetailRow,
  type ProjectListRow,
  type ResetProjectOptions,
  type ResetProjectResult,
  resetProject as resetProjectDb,
} from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/projects.ts` — server-only wrappers around the
 * project helpers from M08b S10 (`packages/db/src/projects.ts`).
 */

export async function listProjects(): Promise<ProjectListRow[]> {
  const handle = createWebDb();
  return listProjectsDb(handle);
}

export async function getProject(identifier: string): Promise<ProjectDetailRow | null> {
  const handle = createWebDb();
  return getProjectByIdentifierDb(handle, identifier);
}

export async function resetProject(
  identifier: string,
  options: ResetProjectOptions = {},
): Promise<ResetProjectResult | null> {
  const handle = createWebDb();
  const project = await getProjectByIdentifierDb(handle, identifier);
  if (project === null) return null;
  return resetProjectDb(handle, project.id, options);
}
