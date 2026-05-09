import {
  type DbHandle,
  getRunWithEverything,
  type ListRunsFilter,
  listProjects,
  listRunsForProject,
  type RunRow,
  type RunWithEverything,
} from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/runs.ts` — thin server-only wrapper around the
 * runs-admin helpers from M08b S11 (`packages/db/src/runs-admin.ts`).
 * Every server component / server action that needs run data goes
 * through here so the storage-adapter selection is centralised.
 *
 * Defaults: 50-row limit on list (per `docs/feature-packs/04-web-app/
 * wireframes/02-screens/runs-list.md`); explicit pagination is reserved
 * for an S3 follow-up if needed.
 */

export interface ListRunsResult {
  readonly runs: ReadonlyArray<RunRow>;
  readonly hasMore: boolean;
  readonly limit: number;
}

export async function listRuns(filter: ListRunsFilter & { db?: DbHandle } = {}): Promise<ListRunsResult> {
  const handle = filter.db ?? createWebDb();
  const limit = filter.limit ?? 50;
  // We over-fetch by 1 to detect whether more rows exist beyond the page.
  const rows = await listRunsForProject(handle, { ...filter, limit: limit + 1 });
  const hasMore = rows.length > limit;
  return { runs: hasMore ? rows.slice(0, limit) : rows, hasMore, limit };
}

export async function getRun(runId: string, db?: DbHandle): Promise<RunWithEverything | null> {
  const handle = db ?? createWebDb();
  return getRunWithEverything(handle, runId);
}

export interface ProjectFilterOption {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export async function listProjectsForFilter(db?: DbHandle): Promise<ProjectFilterOption[]> {
  const handle = db ?? createWebDb();
  const rows = await listProjects(handle);
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name }));
}
