import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, count, desc, eq, gt } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/project-home.ts` — server-only aggregator for
 * `/projects/[slug]` (M04 Phase 2 S2b project home dashboard).
 *
 * Same shape as the Phase 1 dashboard snapshot but scoped to a single
 * `projects.id`. Built fresh (rather than passing `projectId` into
 * the existing `fetchDashboardSnapshot`) so the project-home polling
 * cadence + scoping rules can evolve independently of the picker
 * polling.
 */

export interface ProjectHomeEvent {
  readonly id: string;
  readonly runId: string | null;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly createdAt: string; // ISO
}

export interface ProjectHomeSnapshot {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly activeRuns: number;
  readonly denials24h: number;
  readonly activeKillSwitches: number;
  readonly latestEvents: ReadonlyArray<ProjectHomeEvent>;
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;
}

export async function fetchProjectHomeSnapshot(args: {
  readonly projectId: string;
  readonly projectSlug: string;
}): Promise<ProjectHomeSnapshot> {
  const handle = createWebDb();
  const mode = (process.env.COODRA_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';

  const [activeRunsCount, denials24hCount, activeKillSwitches, latestEvents] = await Promise.all([
    countActiveRunsForProject(handle, args.projectId),
    countDenialsLast24hForProject(handle, args.projectId),
    countKillSwitchesForProjectSlug(handle, args.projectSlug),
    fetchLatestEventsForProject(handle, args.projectId),
  ]);

  return {
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    activeRuns: activeRunsCount,
    denials24h: denials24hCount,
    activeKillSwitches,
    latestEvents,
    mode,
    fetchedAt: new Date().toISOString(),
  };
}

async function countActiveRunsForProject(handle: ReturnType<typeof createWebDb>, projectId: string): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.status, 'in_progress'), eq(t.projectId, projectId)));
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.runs;
  const rows = await handle.db
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.status, 'in_progress'), eq(t.projectId, projectId)));
  return Number(rows[0]?.n ?? 0);
}

async function countDenialsLast24hForProject(
  handle: ReturnType<typeof createWebDb>,
  projectId: string,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const rows = await handle.db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, since), eq(t.projectId, projectId)));
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.policyDecisions;
  const rows = await handle.db
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, since), eq(t.projectId, projectId)));
  return Number(rows[0]?.n ?? 0);
}

async function countKillSwitchesForProjectSlug(
  handle: ReturnType<typeof createWebDb>,
  projectSlug: string,
): Promise<number> {
  // Project-scoped kill switches only (scope=project, target=slug).
  // Global / tool / agent_type switches affect every project but are
  // surfaced workspace-wide.
  const all = await listAllActiveKillSwitches(handle);
  return all.filter((ks) => ks.scope === 'project' && ks.target === projectSlug).length;
}

async function fetchLatestEventsForProject(
  handle: ReturnType<typeof createWebDb>,
  projectId: string,
): Promise<ProjectHomeEvent[]> {
  // Need run_events scoped to the project — but run_events doesn't have
  // a project_id column. Join via runs.
  if (handle.kind === 'sqlite') {
    const re = sqliteSchema.runEvents;
    const r = sqliteSchema.runs;
    const rows = await handle.db
      .select({
        id: re.id,
        runId: re.runId,
        phase: re.phase,
        toolName: re.toolName,
        toolUseId: re.toolUseId,
        createdAt: re.createdAt,
      })
      .from(re)
      .innerJoin(r, eq(re.runId, r.id))
      .where(eq(r.projectId, projectId))
      .orderBy(desc(re.createdAt))
      .limit(10);
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      phase: row.phase,
      toolName: row.toolName,
      toolUseId: row.toolUseId,
      createdAt: row.createdAt.toISOString(),
    }));
  }
  const re = postgresSchema.runEvents;
  const r = postgresSchema.runs;
  const rows = await handle.db
    .select({
      id: re.id,
      runId: re.runId,
      phase: re.phase,
      toolName: re.toolName,
      toolUseId: re.toolUseId,
      createdAt: re.createdAt,
    })
    .from(re)
    .innerJoin(r, eq(re.runId, r.id))
    .where(eq(r.projectId, projectId))
    .orderBy(desc(re.createdAt))
    .limit(10);
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    phase: row.phase,
    toolName: row.toolName,
    toolUseId: row.toolUseId,
    createdAt: row.createdAt.toISOString(),
  }));
}
