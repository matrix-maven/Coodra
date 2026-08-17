import { type PostgresDb, postgresSchema, type SqliteDb, sqliteSchema } from '@coodra/db';
import { and, count, eq, isNotNull, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * COOD-87 — utilization, not inventory.
 *
 * The dashboard has always reported **inventory**: packs created,
 * decisions recorded, Work Packs updated. Those are vanity metrics.
 * They rise when Coodra nags effectively, and would look healthy on a
 * project where every pack is noise nobody ever reads.
 *
 * Every artifact has four stages and the dashboard showed one:
 *
 *   Created → Surfaced → Pulled → Stale/Contradicted
 *
 * Two north-star numbers per surface, and deliberately **no composite
 * score** — a single "memory health" figure hides exactly the
 * diagnostics that make it actionable:
 *
 *   - **pull-through rate** — was this memory wanted?
 *   - **stale share** — was it still trustworthy?
 *
 * ## Reads rollups, never raw events
 *
 * Every query here hits `memory_access_daily` or `memory_cohorts`.
 * `memory_access_events` is pruned on a retention window (COOD-79), so
 * a dashboard reading it would silently lose history AND degrade on
 * exactly the long-running projects this epic exists to serve. The
 * cohort table is small and kept longer, which is what makes
 * "never surfaced again" answerable months later.
 *
 * ## Policy metrics are NOT here
 *
 * They come from `policy_decisions`, which already carries
 * `ask_outcome`, `matched_rule_id`, `governance_verdict` and the
 * decision triad with more fidelity than this log could. Sourcing them
 * from memory access rows would create a second source of truth for
 * policy — see `queries/policies.ts`.
 */

/** One surface's two north-star numbers, plus the counts behind them. */
export interface SurfaceUtilization {
  readonly surface: string;
  /** Distinct items ever surfaced (pushed or pulled). */
  readonly surfaced: number;
  /** Of those, how many the agent then asked for by id. */
  readonly pulled: number;
  /**
   * `pulled / surfaced`, or null when nothing has been surfaced yet.
   *
   * Null rather than 0: "we have shown nothing" and "we showed things
   * and nobody wanted them" are opposite diagnoses, and a 0% that
   * actually means "no data" is the kind of number people act on
   * wrongly.
   */
  readonly pullThroughRate: number | null;
  /** Accesses where the item was already stale when surfaced. */
  readonly staleAtAccess: number;
  readonly totalAccesses: number;
  /** `staleAtAccess / totalAccesses`, or null with no accesses. */
  readonly staleShare: number | null;
  readonly totalBytes: number;
}

export interface DeadMemory {
  /** Packs that exist but have never appeared in any cohort. */
  readonly contextPacksNeverSurfaced: number;
  readonly contextPacksTotal: number;
  /** Decisions recorded but never surfaced to an agent. */
  readonly decisionsNeverSurfaced: number;
  readonly decisionsTotal: number;
}

export interface FreshnessBreakdown {
  readonly fresh: number;
  readonly stale: number;
  /** Never checked. NOT the same as fresh — see COOD-85. */
  readonly unverified: number;
}

export interface MemoryUtilizationSnapshot {
  readonly bySurface: ReadonlyArray<SurfaceUtilization>;
  readonly deadMemory: DeadMemory;
  readonly packFreshness: FreshnessBreakdown;
  readonly decisionFreshness: FreshnessBreakdown;
  /** True until the rollup worker has produced anything to read. */
  readonly noDataYet: boolean;
  readonly fetchedAt: string;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Raw counts, dialect-free.
 *
 * Every field is a plain number or string, so all the assembly below —
 * ratios, dead-memory arithmetic, surface mapping — is written once and
 * shared. Only the reads are duplicated per dialect, and they have to
 * be: `handle.db` is a union of the Postgres and SQLite builders, whose
 * `.select()` signatures are not mutually assignable, so it is callable
 * only after `handle.kind` narrows it. Assigning the discriminant to a
 * local (`const isSqlite = handle.kind === 'sqlite'`) does NOT narrow
 * `handle` — which is exactly how this file shipped uncompilable.
 */
interface RawUtilization {
  readonly dailyRows: ReadonlyArray<{
    readonly site: string;
    readonly accesses: number | null;
    readonly stale: number | null;
    readonly bytes: number | null;
  }>;
  readonly cohortRows: ReadonlyArray<{
    readonly memoryType: string;
    readonly surfaced: number | null;
    readonly pulled: number | null;
  }>;
  readonly packsTotal: number;
  readonly decisionsTotal: number;
  readonly packsSurfaced: number;
  readonly decisionsSurfaced: number;
  readonly packFreshness: FreshnessBreakdown;
  readonly decisionFreshness: FreshnessBreakdown;
}

function breakdownFrom(
  rows: ReadonlyArray<{ readonly status: string | null; readonly n: number }>,
): FreshnessBreakdown {
  const get = (status: string) => Number(rows.find((r) => r.status === status)?.n ?? 0);
  return { fresh: get('fresh'), stale: get('stale'), unverified: get('unverified') };
}

async function readSqlite(db: SqliteDb): Promise<RawUtilization> {
  const daily = sqliteSchema.memoryAccessDaily;
  const cohorts = sqliteSchema.memoryCohorts;
  const packs = sqliteSchema.contextPacks;
  const decisions = sqliteSchema.decisions;

  const dailyRows = await db
    .select({
      site: daily.site,
      accesses: sql<number>`SUM(${daily.accessCount})`,
      stale: sql<number>`SUM(${daily.staleAtAccessCount})`,
      bytes: sql<number>`SUM(${daily.totalBytes})`,
    })
    .from(daily)
    .groupBy(daily.site);

  const cohortRows = await db
    .select({
      memoryType: cohorts.memoryType,
      surfaced: sql<number>`SUM(CASE WHEN ${cohorts.surfacedCount} > 0 THEN 1 ELSE 0 END)`,
      pulled: sql<number>`SUM(CASE WHEN ${cohorts.pulledCount} > 0 THEN 1 ELSE 0 END)`,
    })
    .from(cohorts)
    .groupBy(cohorts.memoryType);

  const [packTotal] = await db.select({ n: count() }).from(packs);
  const [decisionTotal] = await db.select({ n: count() }).from(decisions);
  const [packsSurfaced] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${cohorts.memoryId})` })
    .from(cohorts)
    .where(and(eq(cohorts.memoryType, 'context_pack'), isNotNull(cohorts.memoryId)));
  const [decisionsSurfaced] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${cohorts.memoryId})` })
    .from(cohorts)
    .where(and(eq(cohorts.memoryType, 'decision'), isNotNull(cohorts.memoryId)));
  const packFresh = await db
    .select({ status: packs.freshnessStatus, n: count() })
    .from(packs)
    .groupBy(packs.freshnessStatus);
  const decisionFresh = await db
    .select({ status: decisions.freshnessStatus, n: count() })
    .from(decisions)
    .groupBy(decisions.freshnessStatus);

  return {
    dailyRows,
    cohortRows,
    packsTotal: Number(packTotal?.n ?? 0),
    decisionsTotal: Number(decisionTotal?.n ?? 0),
    packsSurfaced: Number(packsSurfaced?.n ?? 0),
    decisionsSurfaced: Number(decisionsSurfaced?.n ?? 0),
    packFreshness: breakdownFrom(packFresh),
    decisionFreshness: breakdownFrom(decisionFresh),
  };
}

async function readPostgres(db: PostgresDb): Promise<RawUtilization> {
  const daily = postgresSchema.memoryAccessDaily;
  const cohorts = postgresSchema.memoryCohorts;
  const packs = postgresSchema.contextPacks;
  const decisions = postgresSchema.decisions;

  const dailyRows = await db
    .select({
      site: daily.site,
      accesses: sql<number>`SUM(${daily.accessCount})`,
      stale: sql<number>`SUM(${daily.staleAtAccessCount})`,
      bytes: sql<number>`SUM(${daily.totalBytes})`,
    })
    .from(daily)
    .groupBy(daily.site);

  const cohortRows = await db
    .select({
      memoryType: cohorts.memoryType,
      surfaced: sql<number>`SUM(CASE WHEN ${cohorts.surfacedCount} > 0 THEN 1 ELSE 0 END)`,
      pulled: sql<number>`SUM(CASE WHEN ${cohorts.pulledCount} > 0 THEN 1 ELSE 0 END)`,
    })
    .from(cohorts)
    .groupBy(cohorts.memoryType);

  const [packTotal] = await db.select({ n: count() }).from(packs);
  const [decisionTotal] = await db.select({ n: count() }).from(decisions);
  const [packsSurfaced] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${cohorts.memoryId})` })
    .from(cohorts)
    .where(and(eq(cohorts.memoryType, 'context_pack'), isNotNull(cohorts.memoryId)));
  const [decisionsSurfaced] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${cohorts.memoryId})` })
    .from(cohorts)
    .where(and(eq(cohorts.memoryType, 'decision'), isNotNull(cohorts.memoryId)));
  const packFresh = await db
    .select({ status: packs.freshnessStatus, n: count() })
    .from(packs)
    .groupBy(packs.freshnessStatus);
  const decisionFresh = await db
    .select({ status: decisions.freshnessStatus, n: count() })
    .from(decisions)
    .groupBy(decisions.freshnessStatus);

  return {
    dailyRows,
    cohortRows,
    packsTotal: Number(packTotal?.n ?? 0),
    decisionsTotal: Number(decisionTotal?.n ?? 0),
    packsSurfaced: Number(packsSurfaced?.n ?? 0),
    decisionsSurfaced: Number(decisionsSurfaced?.n ?? 0),
    packFreshness: breakdownFrom(packFresh),
    decisionFreshness: breakdownFrom(decisionFresh),
  };
}

export async function fetchMemoryUtilization(): Promise<MemoryUtilizationSnapshot> {
  // Cached handle owned by `lib/db`; not ours to close.
  const handle = createWebDb();
  const raw = handle.kind === 'sqlite' ? await readSqlite(handle.db) : await readPostgres(handle.db);

  const pullByType = new Map(raw.cohortRows.map((row) => [row.memoryType, row]));

  const bySurface: SurfaceUtilization[] = raw.dailyRows.map((row) => {
    // Sites map to the memory type they carry; a site with no cohort
    // data reports null rather than 0.
    const type = row.site.includes('decision')
      ? 'decision'
      : row.site.includes('wiki')
        ? 'wiki_page'
        : row.site.includes('recipe')
          ? 'recipe'
          : 'context_pack';
    const cohort = pullByType.get(type);
    const surfaced = Number(cohort?.surfaced ?? 0);
    const pulled = Number(cohort?.pulled ?? 0);
    const accesses = Number(row.accesses ?? 0);
    const stale = Number(row.stale ?? 0);
    return {
      surface: row.site,
      surfaced,
      pulled,
      pullThroughRate: ratio(pulled, surfaced),
      staleAtAccess: stale,
      totalAccesses: accesses,
      staleShare: ratio(stale, accesses),
      totalBytes: Number(row.bytes ?? 0),
    };
  });

  return {
    bySurface,
    deadMemory: {
      contextPacksNeverSurfaced: Math.max(0, raw.packsTotal - raw.packsSurfaced),
      contextPacksTotal: raw.packsTotal,
      decisionsNeverSurfaced: Math.max(0, raw.decisionsTotal - raw.decisionsSurfaced),
      decisionsTotal: raw.decisionsTotal,
    },
    packFreshness: raw.packFreshness,
    decisionFreshness: raw.decisionFreshness,
    // Distinguishes "nothing to show yet" from "everything is zero",
    // so a fresh install reads as pending rather than broken.
    noDataYet: raw.dailyRows.length === 0 && raw.cohortRows.length === 0,
    fetchedAt: new Date().toISOString(),
  };
}
