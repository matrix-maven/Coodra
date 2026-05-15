import {
  type DbHandle,
  type DecisionWithProject,
  type ListDecisionsFilter,
  listAllDecisions,
} from '@coodra/db';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web-v2/lib/queries/decisions.ts` — workspace-level decision
 * read surface. Pre-cleanup (2026-05-08) decisions were only visible
 * per-run on `/runs/[id]`; the agent's `query_decisions` MCP tool
 * existed but operators had no equivalent web view. This module wraps
 * the new `listAllDecisions` helper that joins decisions to their
 * runs and projects so the listing can chip-link by project.
 */

export async function listDecisions(
  filter: ListDecisionsFilter & { db?: DbHandle } = {},
): Promise<DecisionWithProject[]> {
  const handle = filter.db ?? createWebDb();
  return listAllDecisions(handle, filter);
}
