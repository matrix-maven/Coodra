import type { ContextPackRow, RunRow } from '@coodra/contextos-db';

import { createWebDb } from '@/lib/db';
import { listContextPacks } from '@/lib/queries/context-packs';
import { listRuns } from '@/lib/queries/runs';

/**
 * `apps/web/lib/queries/pack-runs.ts` — combined feature-pack ↔ runs ↔
 * context-packs query for M04 Phase 2 S7.
 *
 * Scope today: returns runs and context packs scoped to the *project*
 * that owns the pack. The schema does not carry a `feature_pack_id`
 * column on `context_packs` or `runs` (`apps/mcp-server/src/tools/
 * save-context-pack/schema.ts` accepts it but discards the value),
 * so per-pack filtering would be artificial.
 *
 * When M05 (NL Assembly) lands the `feature_pack_id` FK, this query
 * gains a `WHERE feature_pack_id = ?` filter. The page already
 * displays the scope honestly so the upgrade is transparent.
 */

export interface PackRunsResult {
  readonly runs: ReadonlyArray<RunRow>;
  readonly contextPacks: ReadonlyArray<ContextPackRow>;
  readonly hasMoreRuns: boolean;
  readonly runsLimit: number;
  readonly contextPacksLimit: number;
}

export interface PackRunsFilter {
  readonly projectId: string;
  readonly runsLimit?: number;
  readonly contextPacksLimit?: number;
}

export async function listRunsAndContextPacksForProject(filter: PackRunsFilter): Promise<PackRunsResult> {
  const db = createWebDb();
  const runsLimit = filter.runsLimit ?? 50;
  const contextPacksLimit = filter.contextPacksLimit ?? 50;
  // Run the two queries in parallel — neither depends on the other.
  const [runsResult, contextPacks] = await Promise.all([
    listRuns({ db, projectId: filter.projectId, limit: runsLimit }),
    listContextPacks({ db, projectId: filter.projectId, limit: contextPacksLimit }),
  ]);
  return {
    runs: runsResult.runs,
    contextPacks,
    hasMoreRuns: runsResult.hasMore,
    runsLimit,
    contextPacksLimit,
  };
}
