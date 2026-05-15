import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, count, desc, eq, gt } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/dashboard.ts` — server-only aggregation
 * queries for the dashboard home (M04 S9). Each tile is one
 * focused query; the page composes them in parallel.
 *
 * Polling cadence is 2000ms per spec §8 (the dashboard is the
 * cheapest live surface — count queries on indexed columns).
 */

export interface DashboardSnapshot {
  readonly activeRuns: number;
  readonly denials24h: number;
  readonly activeKillSwitches: number;
  readonly latestEvents: ReadonlyArray<DashboardEvent>;
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;
}

export interface DashboardEvent {
  readonly id: string;
  readonly runId: string | null;
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly createdAt: string; // ISO
}

export async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const handle = createWebDb();
  const mode = (process.env.COODRA_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';

  const [activeRunsCount, denials24hCount, killSwitchRows, latestEvents] = await Promise.all([
    countActiveRuns(handle),
    countDenialsLast24h(handle),
    listAllActiveKillSwitches(handle),
    fetchLatestEvents(handle),
  ]);

  return {
    activeRuns: activeRunsCount,
    denials24h: denials24hCount,
    activeKillSwitches: killSwitchRows.length,
    latestEvents,
    mode,
    fetchedAt: new Date().toISOString(),
  };
}

async function countActiveRuns(handle: ReturnType<typeof createWebDb>): Promise<number> {
  if (handle.kind === 'sqlite') {
    const rows = await handle.db
      .select({ n: count() })
      .from(sqliteSchema.runs)
      .where(eq(sqliteSchema.runs.status, 'in_progress'));
    return rows[0]?.n ?? 0;
  }
  const rows = await handle.db
    .select({ n: count() })
    .from(postgresSchema.runs)
    .where(eq(postgresSchema.runs.status, 'in_progress'));
  return Number(rows[0]?.n ?? 0);
}

async function countDenialsLast24h(handle: ReturnType<typeof createWebDb>): Promise<number> {
  // 24h cutoff in unix seconds (sqlite columns are integer unix seconds)
  // / Date object (postgres columns are timestamptz).
  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - 24 * 3600;
  const sinceDate = new Date(sinceUnixSeconds * 1000);

  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const rows = await handle.db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, sinceDate)));
    return rows[0]?.n ?? 0;
  }
  const t = postgresSchema.policyDecisions;
  const rows = await handle.db
    .select({ n: count() })
    .from(t)
    .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, sinceDate)));
  return Number(rows[0]?.n ?? 0);
}

async function fetchLatestEvents(handle: ReturnType<typeof createWebDb>): Promise<DashboardEvent[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runEvents;
    const rows = await handle.db.select().from(t).orderBy(desc(t.createdAt)).limit(10);
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      phase: r.phase,
      toolName: r.toolName,
      toolUseId: r.toolUseId,
      createdAt: r.createdAt.toISOString(),
    }));
  }
  const t = postgresSchema.runEvents;
  const rows = await handle.db.select().from(t).orderBy(desc(t.createdAt)).limit(10);
  return rows.map((r) => ({
    id: r.id,
    runId: r.runId,
    phase: r.phase,
    toolName: r.toolName,
    toolUseId: r.toolUseId,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Stub: returns 0/0 for {red, yellow}. Real impl shells out to
 * `coodra doctor --json` and caches the result for 60s. The shell
 * dependency means this only works in solo (the doctor binary is the
 * developer's local CLI); team mode renders the tile with a caption
 * "Per-developer doctor; no cloud rollup."
 *
 * S9 ships the stub so the dashboard renders without doctor data; an
 * S9 follow-up wires the real shell-out (kept narrow because it
 * adds a process spawn surface).
 */
export async function fetchDoctorSummary(): Promise<{ red: number; yellow: number; available: boolean }> {
  // Reserved for an S9 follow-up — see lib/queries/dashboard.ts docblock.
  return Promise.resolve({ red: 0, yellow: 0, available: false });
}
