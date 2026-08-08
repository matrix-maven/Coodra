import {
  type ContextPackRow,
  type DbHandle,
  type DecisionWithProject,
  getDecisionById,
  type ListDecisionsFilter,
  listAllDecisions,
  listContextPacksForRuns,
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

export async function getDecision(id: string, db?: DbHandle): Promise<DecisionWithProject | null> {
  const handle = db ?? createWebDb();
  return getDecisionById(handle, id);
}

/**
 * Context packs across every run these decisions belong to — the raw
 * material for `packsLinkingDecision` (see `lib/context-pack-links.ts`).
 * Batched by distinct runId rather than one query per decision.
 */
export async function listContextPacksForDecisions(
  decisions: ReadonlyArray<{ readonly runId: string | null }>,
  db?: DbHandle,
): Promise<ContextPackRow[]> {
  const handle = db ?? createWebDb();
  const runIds = [...new Set(decisions.map((d) => d.runId).filter((id): id is string => id !== null))];
  return listContextPacksForRuns(handle, runIds);
}
