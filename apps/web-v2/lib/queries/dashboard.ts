import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, count, desc, eq, gt, ne, notLike, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * web-v2 dashboard query — extended snapshot for the editorial home page.
 * Same query envelope as apps/web; richer payload (totalRuns, allow24h,
 * latestRuns).
 */

export interface DashboardSnapshot {
  readonly activeRuns: number;
  readonly totalRuns: number;
  readonly denials24h: number;
  readonly allow24h: number;
  readonly activeKillSwitches: number;
  readonly latestEvents: ReadonlyArray<DashboardEvent>;
  readonly latestRuns: ReadonlyArray<DashboardRun>;
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;
  /**
   * Module 05 §6.E — agent narrative coverage over the last 7 days.
   * `agentCount / totalCount` of completed runs that have a Context
   * Pack with `source = 'agent'` (i.e., the agent called
   * `save_context_pack` explicitly rather than relying on the bridge's
   * fallback). Surfaces compliance — when this drops, mechanisms A-D
   * need attention.
   */
  readonly narrativeCoverage7d: NarrativeCoverage;
  /** Decision-capture coverage over the last 30d (longer window — decisions are rarer than packs). */
  readonly decisionCapture30d: DecisionCapture;
}

export interface NarrativeCoverage {
  /** Count of context_packs rows in the window, regardless of source. */
  readonly totalPacks: number;
  /** Count of context_packs rows in the window with source='agent'. */
  readonly agentAuthoredPacks: number;
  /** agentAuthoredPacks / totalPacks; null when totalPacks === 0. */
  readonly ratio: number | null;
}

/**
 * Decision-capture coverage: of completed runs in the last 30 days, how
 * many have at least one `decisions` row? The narrative-coverage stat
 * tells you whether the agent saved a recap; this stat tells you
 * whether the agent recorded any architectural intent during the run.
 *
 * This is the central observability of "is the agent actually doing
 * the structured-recording work it's supposed to?" — see the M05
 * trigger contract reframe (agent-canonical).
 */
export interface DecisionCapture {
  /** Completed runs in the 30-day window. */
  readonly totalCompletedRuns: number;
  /** How many of those have ≥1 decision recorded. */
  readonly runsWithDecision: number;
  /** runsWithDecision / totalCompletedRuns; null when no completed runs. */
  readonly ratio: number | null;
}

export interface DashboardEvent {
  readonly id: string;
  readonly runId: string | null;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly outcome: string | null;
  readonly createdAt: string;
}

export interface DashboardRun {
  readonly id: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const handle = createWebDb();
  // Resolve mode from the deployment-mode helper (the only authority that
  // also recognizes `COODRA_DEPLOYMENT=team-hosted`). Reading
  // `process.env.COODRA_MODE` here would silently render the dashboard
  // as solo on team-hosted deployments because that env var only ships
  // in the local-team .env file.
  const { resolveDeploymentMode } = await import('@/lib/deployment-mode');
  const mode: 'solo' | 'team' = resolveDeploymentMode() === 'local-solo' ? 'solo' : 'team';
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [
    activeRunsCount,
    totalRunsCount,
    denials24h,
    allow24h,
    killSwitchRows,
    latestEvents,
    latestRuns,
    narrativeCoverage7d,
    decisionCapture30d,
  ] = await Promise.all([
    countRuns(handle, 'in_progress'),
    countRuns(handle),
    countDecisions(handle, 'deny', since),
    countDecisions(handle, 'allow', since),
    listAllActiveKillSwitches(handle),
    fetchLatestEvents(handle),
    fetchLatestRuns(handle),
    fetchNarrativeCoverage(handle, since7d),
    fetchDecisionCapture(handle, since30d),
  ]);

  return {
    activeRuns: activeRunsCount,
    totalRuns: totalRunsCount,
    denials24h,
    allow24h,
    activeKillSwitches: killSwitchRows.length,
    latestEvents,
    latestRuns,
    mode,
    fetchedAt: new Date().toISOString(),
    narrativeCoverage7d,
    decisionCapture30d,
  };
}

/**
 * Module 05 follow-up — decision capture rate.
 * Of completed runs in the window, how many have ≥1 decision recorded.
 * Counterpart to narrative coverage; surfaces "the agent rarely calls
 * record_decision" as a visible metric.
 */
async function fetchDecisionCapture(handle: ReturnType<typeof createWebDb>, since: Date): Promise<DecisionCapture> {
  if (handle.kind === 'sqlite') {
    const r = sqliteSchema.runs;
    // Total completed in window
    const totalRows = await handle.db
      .select({ n: count() })
      .from(r)
      .where(and(eq(r.status, 'completed'), gt(r.endedAt, since)));
    const totalCompletedRuns = Number(totalRows[0]?.n ?? 0);

    // Distinct runIds with ≥1 decision in the same window. Use Drizzle's
    // sql template tag — better-sqlite3 binds `since.getTime()/1000` as
    // a number, comparing against the integer-timestamp column.
    const sinceUnix = Math.floor(since.getTime() / 1000);
    const decRunRows = (await handle.db.all(
      sql`SELECT COUNT(DISTINCT d.run_id) AS n
          FROM decisions d
          JOIN runs r ON r.id = d.run_id
          WHERE r.status = 'completed' AND r.ended_at > ${sinceUnix}`,
    )) as Array<{ n: number }>;
    const runsWithDecision = Number(decRunRows[0]?.n ?? 0);

    return {
      totalCompletedRuns,
      runsWithDecision,
      ratio: totalCompletedRuns === 0 ? null : runsWithDecision / totalCompletedRuns,
    };
  }
  // Postgres branch — same shape with parameterized SQL.
  const r = postgresSchema.runs;
  const totalRows = await handle.db
    .select({ n: count() })
    .from(r)
    .where(and(eq(r.status, 'completed'), gt(r.endedAt, since)));
  const totalCompletedRuns = Number(totalRows[0]?.n ?? 0);

  // postgres-js refuses to bind a `Date` instance to a raw-sql query
  // ("string argument must be of type string or Buffer"). Format the
  // window cutoff as ISO before sending — Postgres parses ISO timestamps
  // unambiguously and the index on runs.ended_at still matches.
  const sinceIso = since.toISOString();
  const decRunRows = (await handle.db.execute(
    sql`SELECT COUNT(DISTINCT d.run_id) AS n
        FROM decisions d
        JOIN runs r ON r.id = d.run_id
        WHERE r.status = 'completed' AND r.ended_at > ${sinceIso}::timestamptz`,
  )) as unknown as Array<{ n: number }>;
  const runsWithDecision = Number(decRunRows[0]?.n ?? 0);

  return {
    totalCompletedRuns,
    runsWithDecision,
    ratio: totalCompletedRuns === 0 ? null : runsWithDecision / totalCompletedRuns,
  };
}

/**
 * Module 05 §6.E — agent narrative coverage. Counts context_packs rows
 * in the window split by `source`. Returns the ratio (or null when no
 * packs exist) so the dashboard can show "—" rather than 0% on empty
 * workspaces.
 */
async function fetchNarrativeCoverage(handle: ReturnType<typeof createWebDb>, since: Date): Promise<NarrativeCoverage> {
  if (handle.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const totalRows = await handle.db.select({ n: count() }).from(cp).where(gt(cp.createdAt, since));
    const agentRows = await handle.db
      .select({ n: count() })
      .from(cp)
      .where(and(gt(cp.createdAt, since), eq(cp.source, 'agent')));
    const totalPacks = Number(totalRows[0]?.n ?? 0);
    const agentAuthoredPacks = Number(agentRows[0]?.n ?? 0);
    return {
      totalPacks,
      agentAuthoredPacks,
      ratio: totalPacks === 0 ? null : agentAuthoredPacks / totalPacks,
    };
  }
  const cp = postgresSchema.contextPacks;
  const totalRows = await handle.db.select({ n: count() }).from(cp).where(gt(cp.createdAt, since));
  const agentRows = await handle.db
    .select({ n: count() })
    .from(cp)
    .where(and(gt(cp.createdAt, since), eq(cp.source, 'agent')));
  const totalPacks = Number(totalRows[0]?.n ?? 0);
  const agentAuthoredPacks = Number(agentRows[0]?.n ?? 0);
  return {
    totalPacks,
    agentAuthoredPacks,
    ratio: totalPacks === 0 ? null : agentAuthoredPacks / totalPacks,
  };
}

async function countRuns(handle: ReturnType<typeof createWebDb>, status?: string): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const q = handle.db.select({ n: count() }).from(t);
    const rows = await (status === undefined ? q : q.where(eq(t.status, status)));
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.runs;
  const q = handle.db.select({ n: count() }).from(t);
  const rows = await (status === undefined ? q : q.where(eq(t.status, status)));
  return Number(rows[0]?.n ?? 0);
}

async function countDecisions(
  handle: ReturnType<typeof createWebDb>,
  verdict: 'deny' | 'allow',
  since: Date,
): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const rows = await handle.db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.permissionDecision, verdict), gt(t.createdAt, since)));
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.policyDecisions;
  const rows = await handle.db
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.permissionDecision, verdict), gt(t.createdAt, since)));
  return Number(rows[0]?.n ?? 0);
}

async function fetchLatestEvents(handle: ReturnType<typeof createWebDb>): Promise<DashboardEvent[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runEvents;
    const rows = await handle.db.select().from(t).orderBy(desc(t.createdAt)).limit(8);
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      phase: r.phase,
      toolName: r.toolName,
      toolUseId: r.toolUseId,
      outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
    }));
  }
  const t = postgresSchema.runEvents;
  const rows = await handle.db.select().from(t).orderBy(desc(t.createdAt)).limit(8);
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    phase: r.phase,
    toolName: r.toolName,
    toolUseId: r.toolUseId,
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
  }));
}

async function fetchLatestRuns(handle: ReturnType<typeof createWebDb>): Promise<DashboardRun[]> {
  // Hide abandoned + synthetic backfill rows from the dashboard's
  // "Recent runs" panel — same defaults as the /runs page. Operators
  // who want the full picture click through to /runs?showNoise=1.
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db
      .select()
      .from(t)
      .where(and(ne(t.status, 'abandoned'), notLike(t.sessionId, '%orphan-backfill%')))
      .orderBy(desc(t.startedAt))
      .limit(6);
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      sessionId: r.sessionId,
      agentType: r.agentType,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    }));
  }
  const t = postgresSchema.runs;
  const rows = await handle.db
    .select()
    .from(t)
    .where(and(ne(t.status, 'abandoned'), notLike(t.sessionId, '%orphan-backfill%')))
    .orderBy(desc(t.startedAt))
    .limit(6);
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    sessionId: r.sessionId,
    agentType: r.agentType,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  }));
}
