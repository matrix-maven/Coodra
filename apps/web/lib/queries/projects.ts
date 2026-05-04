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
 *
 * M04 Phase 2 S1 (F2): listProjects() filters the `__global__`
 * sentinel out. The sentinel is real data (it anchors policy_rules
 * for un-registered cwds per F7 invariant) but it should never appear
 * in user-facing project listings — pre-fix audit caught the
 * "Global Policy Rules" row alongside real projects on `/projects`.
 * `getProject('__global__')` still resolves so deep-link inspection
 * works; only the list view hides it.
 */

const SENTINEL_PROJECT_SLUGS: ReadonlySet<string> = new Set(['__global__']);

export async function listProjects(): Promise<ProjectListRow[]> {
  const handle = createWebDb();
  const rows = await listProjectsDb(handle);
  return rows.filter((row) => !SENTINEL_PROJECT_SLUGS.has(row.slug));
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
