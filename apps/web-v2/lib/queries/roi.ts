import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/db';
import { REUSE_READ_TOOL_NAMES, type RoiMeasuredInputs } from '@coodra/shared/roi';
import { and, count, countDistinct, eq, inArray, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * web-v2 ROI / value query — the MEASURED half of the `/roi` dashboard.
 *
 * Everything this returns is a real count/sum read from Coodra's tables;
 * NOTHING here is modeled. The page passes `snapshot.modeledInputs` into
 * `@coodra/shared/roi::computeRoiBand` to derive the (clearly-badged)
 * dollar/token estimates. Keeping the measured/modeled boundary at this
 * file edge is deliberate — see `docs/coodra-roi-and-metrics-architecture.md`.
 *
 * Dual-dialect: the web reads local SQLite in solo / local-team and cloud
 * Postgres in team-hosted (see `lib/db.ts`); every aggregation branches on
 * `handle.kind`. Org-scoping mirrors `dashboard.ts` (unscoped — the local
 * SQLite store is single-org, and the team-hosted Postgres org-scope is the
 * same separately-tracked limitation the existing dashboard carries).
 */

type Handle = ReturnType<typeof createWebDb>;

const REUSE_TOOLS: string[] = [...REUSE_READ_TOOL_NAMES];
const STALE_AFTER_DAYS = 90;
const TREND_WEEKS = 12;
const DAY_MS = 24 * 3600 * 1000;

export interface RoiTrendPoint {
  /** ISO date of the week-bucket start (oldest → newest). */
  readonly weekStart: string;
  readonly count: number;
}

export interface RoiNamedCount {
  readonly name: string;
  readonly count: number;
}

export interface RoiSnapshot {
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;

  readonly adoption: {
    readonly totalRuns: number;
    readonly completedRuns: number;
    readonly inProgressRuns: number;
    readonly cancelledRuns: number;
    readonly activeProjects: number;
    readonly toolCalls: number;
    readonly agentMix: ReadonlyArray<RoiNamedCount>;
    readonly runsTrend: ReadonlyArray<RoiTrendPoint>;
  };

  readonly governance: {
    readonly governedActions: number;
    readonly blockedActions: number;
    readonly askActions: number;
    readonly activeKillSwitches: number;
  };

  readonly knowledge: {
    readonly contextPacks: number;
    readonly agentAuthoredPacks: number;
    readonly bridgeAutoPacks: number;
    readonly decisions: number;
    readonly featurePacks: number;
    readonly features: number;
    readonly wikis: number;
    readonly wikiPages: number;
    readonly wikiPagesAuthored: number;
    readonly assetsTrend: ReadonlyArray<RoiTrendPoint>;
    // --- reuse / continuity ---
    readonly reuseReads: number;
    readonly reuseByTool: ReadonlyArray<RoiNamedCount>;
    readonly runsWithReuse: number;
    /** KCS Link Rate analogue: completed runs that consulted ≥1 prior asset. */
    readonly linkRatePct: number | null;
    /** Context packs whose meta.decisionIds links ≥1 decision (knowledge graph density). */
    readonly packsLinkingDecisions: number;
    // --- quality / freshness / concentration ---
    /** Decisions with rationale + ≥1 alternative + a confidence set (DIQ/AQI completeness). */
    readonly decisionsComplete: number;
    readonly decisionCompletenessPct: number | null;
    readonly avgAssetAgeDays: number | null;
    readonly stalePct: number | null;
    /** Bus-factor: assets authored by the single most-prolific contributor (team only; null in solo). */
    readonly topAuthorShare: number | null;
    readonly knowledgeCapturedChars: number;
  };

  /** Real counts packaged for `@coodra/shared/roi::computeRoiBand` — the only bridge to the modeled layer. */
  readonly modeledInputs: RoiMeasuredInputs;
}

// ----------------------------------------------------------------------------
// Small dual-dialect count helpers (mirror dashboard.ts shape).
// ----------------------------------------------------------------------------

async function countRuns(handle: Handle, status?: string): Promise<number> {
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

async function countActiveProjects(handle: Handle): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db.select({ n: countDistinct(t.projectId) }).from(t);
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.runs;
  const rows = await handle.db.select({ n: countDistinct(t.projectId) }).from(t);
  return Number(rows[0]?.n ?? 0);
}

async function countRunEvents(handle: Handle): Promise<number> {
  if (handle.kind === 'sqlite') {
    const rows = await handle.db.select({ n: count() }).from(sqliteSchema.runEvents);
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await handle.db.select({ n: count() }).from(postgresSchema.runEvents);
  return Number(rows[0]?.n ?? 0);
}

async function countReuseReads(handle: Handle): Promise<{ total: number; completedRunsWithReuse: number }> {
  // `total` = every reuse-read mcp_call (any run status) — the knowledge-reuse
  // lever values the saved re-derivation regardless of whether the run finished.
  // `completedRunsWithReuse` = distinct COMPLETED runs that recorded ≥1 reuse
  // read — the KCS Link Rate numerator. It is restricted to status='completed'
  // so the rate (÷ completedRuns) can never exceed 100%: a run that recorded
  // reuse but is still in_progress / cancelled is in `total` but not here.
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runEvents;
    const r = sqliteSchema.runs;
    const where = and(eq(t.phase, 'mcp_call'), inArray(t.toolName, REUSE_TOOLS));
    const totalRows = await handle.db.select({ n: count() }).from(t).where(where);
    const distinctRows = await handle.db
      .select({ n: countDistinct(t.runId) })
      .from(t)
      .innerJoin(r, eq(t.runId, r.id))
      .where(and(where, eq(r.status, 'completed')));
    return { total: Number(totalRows[0]?.n ?? 0), completedRunsWithReuse: Number(distinctRows[0]?.n ?? 0) };
  }
  const t = postgresSchema.runEvents;
  const r = postgresSchema.runs;
  const where = and(eq(t.phase, 'mcp_call'), inArray(t.toolName, REUSE_TOOLS));
  const totalRows = await handle.db.select({ n: count() }).from(t).where(where);
  const distinctRows = await handle.db
    .select({ n: countDistinct(t.runId) })
    .from(t)
    .innerJoin(r, eq(t.runId, r.id))
    .where(and(where, eq(r.status, 'completed')));
  return { total: Number(totalRows[0]?.n ?? 0), completedRunsWithReuse: Number(distinctRows[0]?.n ?? 0) };
}

async function reuseByTool(handle: Handle): Promise<RoiNamedCount[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runEvents;
    const rows = await handle.db
      .select({ name: t.toolName, n: count() })
      .from(t)
      .where(and(eq(t.phase, 'mcp_call'), inArray(t.toolName, REUSE_TOOLS)))
      .groupBy(t.toolName);
    return rows.map((r) => ({ name: r.name, count: Number(r.n) })).sort((a, b) => b.count - a.count);
  }
  const t = postgresSchema.runEvents;
  const rows = await handle.db
    .select({ name: t.toolName, n: count() })
    .from(t)
    .where(and(eq(t.phase, 'mcp_call'), inArray(t.toolName, REUSE_TOOLS)))
    .groupBy(t.toolName);
  return rows.map((r) => ({ name: r.name, count: Number(r.n) })).sort((a, b) => b.count - a.count);
}

async function countPolicy(handle: Handle, decision?: string): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const q = handle.db.select({ n: count() }).from(t);
    const rows = await (decision === undefined ? q : q.where(eq(t.permissionDecision, decision)));
    return Number(rows[0]?.n ?? 0);
  }
  const t = postgresSchema.policyDecisions;
  const q = handle.db.select({ n: count() }).from(t);
  const rows = await (decision === undefined ? q : q.where(eq(t.permissionDecision, decision)));
  return Number(rows[0]?.n ?? 0);
}

async function agentMix(handle: Handle): Promise<RoiNamedCount[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db.select({ name: t.agentType, n: count() }).from(t).groupBy(t.agentType);
    return rows.map((r) => ({ name: r.name, count: Number(r.n) })).sort((a, b) => b.count - a.count);
  }
  const t = postgresSchema.runs;
  const rows = await handle.db.select({ name: t.agentType, n: count() }).from(t).groupBy(t.agentType);
  return rows.map((r) => ({ name: r.name, count: Number(r.n) })).sort((a, b) => b.count - a.count);
}

async function simpleCount(handle: Handle, table: 'features' | 'wikis'): Promise<number> {
  if (handle.kind === 'sqlite') {
    const t = table === 'features' ? sqliteSchema.features : sqliteSchema.wikis;
    const rows = await handle.db.select({ n: count() }).from(t);
    return Number(rows[0]?.n ?? 0);
  }
  const t = table === 'features' ? postgresSchema.features : postgresSchema.wikis;
  const rows = await handle.db.select({ n: count() }).from(t);
  return Number(rows[0]?.n ?? 0);
}

async function countFeaturePacks(handle: Handle): Promise<number> {
  if (handle.kind === 'sqlite') {
    const rows = await handle.db.select({ n: count() }).from(sqliteSchema.featurePacks);
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await handle.db.select({ n: count() }).from(postgresSchema.featurePacks);
  return Number(rows[0]?.n ?? 0);
}

async function countWikiPages(handle: Handle): Promise<{ total: number; authored: number }> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.wikiPages;
    const totalRows = await handle.db.select({ n: count() }).from(t);
    const authoredRows = await handle.db.select({ n: count() }).from(t).where(eq(t.state, 'authored'));
    return { total: Number(totalRows[0]?.n ?? 0), authored: Number(authoredRows[0]?.n ?? 0) };
  }
  const t = postgresSchema.wikiPages;
  const totalRows = await handle.db.select({ n: count() }).from(t);
  const authoredRows = await handle.db.select({ n: count() }).from(t).where(eq(t.state, 'authored'));
  return { total: Number(totalRows[0]?.n ?? 0), authored: Number(authoredRows[0]?.n ?? 0) };
}

async function sumChars(handle: Handle): Promise<number> {
  // Total characters of authored knowledge-asset content: context-pack bodies
  // + decision (description + rationale). Used for the "knowledge captured
  // (tokens)" estimate (chars / charsPerToken in the model).
  if (handle.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const d = sqliteSchema.decisions;
    const packRows = await handle.db.select({ c: sql<number>`COALESCE(SUM(LENGTH(${cp.content})), 0)` }).from(cp);
    const decRows = await handle.db
      .select({ c: sql<number>`COALESCE(SUM(LENGTH(${d.description}) + LENGTH(${d.rationale})), 0)` })
      .from(d);
    return Number(packRows[0]?.c ?? 0) + Number(decRows[0]?.c ?? 0);
  }
  const cp = postgresSchema.contextPacks;
  const d = postgresSchema.decisions;
  const packRows = await handle.db.select({ c: sql<number>`COALESCE(SUM(LENGTH(${cp.content})), 0)` }).from(cp);
  const decRows = await handle.db
    .select({ c: sql<number>`COALESCE(SUM(LENGTH(${d.description}) + LENGTH(${d.rationale})), 0)` })
    .from(d);
  return Number(packRows[0]?.c ?? 0) + Number(decRows[0]?.c ?? 0);
}

interface PackMetaRow {
  readonly createdAt: Date;
  readonly source: string;
  readonly meta: string | null;
  readonly author: string | null;
}
interface DecisionMetaRow {
  readonly createdAt: Date;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly confidence: string | null;
  readonly author: string | null;
}

async function fetchPackRows(handle: Handle): Promise<PackMetaRow[]> {
  if (handle.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const rows = await handle.db
      .select({ createdAt: cp.createdAt, source: cp.source, meta: cp.meta, author: cp.createdByUserId })
      .from(cp);
    return rows as PackMetaRow[];
  }
  const cp = postgresSchema.contextPacks;
  const rows = await handle.db
    .select({ createdAt: cp.createdAt, source: cp.source, meta: cp.meta, author: cp.createdByUserId })
    .from(cp);
  return rows as PackMetaRow[];
}

async function fetchDecisionRows(handle: Handle): Promise<DecisionMetaRow[]> {
  if (handle.kind === 'sqlite') {
    const d = sqliteSchema.decisions;
    const rows = await handle.db
      .select({
        createdAt: d.createdAt,
        rationale: d.rationale,
        alternatives: d.alternatives,
        confidence: d.confidence,
        author: d.createdByUserId,
      })
      .from(d);
    return rows as DecisionMetaRow[];
  }
  const d = postgresSchema.decisions;
  const rows = await handle.db
    .select({
      createdAt: d.createdAt,
      rationale: d.rationale,
      alternatives: d.alternatives,
      confidence: d.confidence,
      author: d.createdByUserId,
    })
    .from(d);
  return rows as DecisionMetaRow[];
}

async function fetchRunStartedAt(handle: Handle): Promise<Date[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db.select({ startedAt: t.startedAt }).from(t);
    return rows.map((r) => r.startedAt);
  }
  const t = postgresSchema.runs;
  const rows = await handle.db.select({ startedAt: t.startedAt }).from(t);
  return rows.map((r) => r.startedAt);
}

// ----------------------------------------------------------------------------
// Pure JS reducers over the fetched metadata rows.
// ----------------------------------------------------------------------------

/** Bucket a set of dates into `weeks` trailing weekly bins, oldest → newest. */
function bucketWeekly(dates: ReadonlyArray<Date>, weeks: number, now: Date): RoiTrendPoint[] {
  const points: RoiTrendPoint[] = [];
  const nowMs = now.getTime();
  for (let i = weeks - 1; i >= 0; i--) {
    const start = nowMs - (i + 1) * 7 * DAY_MS;
    const end = nowMs - i * 7 * DAY_MS;
    const n = dates.reduce((acc, d) => {
      const t = d.getTime();
      return t > start && t <= end ? acc + 1 : acc;
    }, 0);
    points.push({ weekStart: new Date(start).toISOString().slice(0, 10), count: n });
  }
  return points;
}

function parseDecisionIdsCount(metaJson: string | null): number {
  if (metaJson === null || metaJson.length === 0) return 0;
  try {
    const parsed = JSON.parse(metaJson) as { decisionIds?: unknown };
    return Array.isArray(parsed.decisionIds) ? parsed.decisionIds.length : 0;
  } catch {
    return 0;
  }
}

function isAlternativesNonEmpty(altJson: string | null): boolean {
  if (altJson === null || altJson.length === 0) return false;
  try {
    const parsed = JSON.parse(altJson) as unknown;
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------

export async function fetchRoiSnapshot(): Promise<RoiSnapshot> {
  const handle = createWebDb();
  const { resolveDeploymentMode } = await import('@/lib/deployment-mode');
  const mode: 'solo' | 'team' = resolveDeploymentMode() === 'local-solo' ? 'solo' : 'team';
  const now = new Date();

  const [
    totalRuns,
    completedRuns,
    inProgressRuns,
    cancelledRuns,
    activeProjects,
    toolCalls,
    reuse,
    reuseTools,
    governedActions,
    blockedActions,
    askActions,
    killSwitches,
    mix,
    agentPacks,
    bridgePacks,
    decisionsTotal,
    featurePacks,
    features,
    wikis,
    wikiPages,
    knowledgeCapturedChars,
    packRows,
    decisionRows,
    runStartedAt,
  ] = await Promise.all([
    countRuns(handle),
    countRuns(handle, 'completed'),
    countRuns(handle, 'in_progress'),
    countRuns(handle, 'cancelled'),
    countActiveProjects(handle),
    countRunEvents(handle),
    countReuseReads(handle),
    reuseByTool(handle),
    countPolicy(handle),
    countPolicy(handle, 'deny'),
    countPolicy(handle, 'ask'),
    listAllActiveKillSwitches(handle),
    agentMix(handle),
    countContextPacks(handle, 'agent'),
    countContextPacks(handle, 'bridge_auto'),
    countDecisionsTotal(handle),
    countFeaturePacks(handle),
    simpleCount(handle, 'features'),
    simpleCount(handle, 'wikis'),
    countWikiPages(handle),
    sumChars(handle),
    fetchPackRows(handle),
    fetchDecisionRows(handle),
    fetchRunStartedAt(handle),
  ]);

  const contextPacks = agentPacks + bridgePacks;

  // --- reuse / link rate ---
  // Numerator restricted to COMPLETED runs (see countReuseReads) so the rate is
  // bounded ≤100% — "of completed runs, how many consulted prior knowledge".
  const runsWithReuse = reuse.completedRunsWithReuse;
  const linkRatePct = completedRuns > 0 ? (runsWithReuse / completedRuns) * 100 : null;

  // --- knowledge-graph density: packs that link ≥1 decision ---
  const packsLinkingDecisions = packRows.reduce((acc, p) => (parseDecisionIdsCount(p.meta) > 0 ? acc + 1 : acc), 0);

  // --- decision completeness (DIQ/AQI) ---
  const decisionsComplete = decisionRows.reduce((acc, d) => {
    const ok =
      d.rationale.trim().length > 0 &&
      isAlternativesNonEmpty(d.alternatives) &&
      d.confidence !== null &&
      d.confidence.length > 0;
    return ok ? acc + 1 : acc;
  }, 0);
  const decisionCompletenessPct = decisionRows.length > 0 ? (decisionsComplete / decisionRows.length) * 100 : null;

  // --- freshness (age + staleness) over all assets ---
  const assetDates = [...packRows.map((p) => p.createdAt), ...decisionRows.map((d) => d.createdAt)];
  const avgAssetAgeDays =
    assetDates.length > 0
      ? assetDates.reduce((acc, d) => acc + (now.getTime() - d.getTime()) / DAY_MS, 0) / assetDates.length
      : null;
  const staleCount = assetDates.reduce(
    (acc, d) => ((now.getTime() - d.getTime()) / DAY_MS > STALE_AFTER_DAYS ? acc + 1 : acc),
    0,
  );
  const stalePct = assetDates.length > 0 ? (staleCount / assetDates.length) * 100 : null;

  // --- concentration / bus-factor (team only; null when no human authors) ---
  const authorCounts = new Map<string, number>();
  for (const p of packRows) if (p.author !== null) authorCounts.set(p.author, (authorCounts.get(p.author) ?? 0) + 1);
  for (const d of decisionRows)
    if (d.author !== null) authorCounts.set(d.author, (authorCounts.get(d.author) ?? 0) + 1);
  const attributedAssets = [...authorCounts.values()].reduce((a, b) => a + b, 0);
  const topAuthorAssets = authorCounts.size > 0 ? Math.max(...authorCounts.values()) : 0;
  const topAuthorShare = attributedAssets > 0 ? (topAuthorAssets / attributedAssets) * 100 : null;

  // --- trends ---
  const assetsTrend = bucketWeekly(assetDates, TREND_WEEKS, now);
  const runsTrend = bucketWeekly(runStartedAt, TREND_WEEKS, now);

  // --- the bridge to the modeled layer (all measured) ---
  const modeledInputs: RoiMeasuredInputs = {
    totalRuns,
    completedRuns,
    toolCalls,
    reuseReads: reuse.total,
    // Assets a human/agent authored: agent-saved packs + decisions (bridge_auto
    // packs are free auto-summaries, NOT authoring effort, so excluded from cost).
    assetsAuthored: agentPacks + decisionsTotal,
    governedActions,
    blockedActions,
    assetContentChars: knowledgeCapturedChars,
  };

  return {
    mode,
    fetchedAt: now.toISOString(),
    adoption: {
      totalRuns,
      completedRuns,
      inProgressRuns,
      cancelledRuns,
      activeProjects,
      toolCalls,
      agentMix: mix,
      runsTrend,
    },
    governance: {
      governedActions,
      blockedActions,
      askActions,
      activeKillSwitches: killSwitches.length,
    },
    knowledge: {
      contextPacks,
      agentAuthoredPacks: agentPacks,
      bridgeAutoPacks: bridgePacks,
      decisions: decisionsTotal,
      featurePacks,
      features,
      wikis,
      wikiPages: wikiPages.total,
      wikiPagesAuthored: wikiPages.authored,
      assetsTrend,
      reuseReads: reuse.total,
      reuseByTool: reuseTools,
      runsWithReuse,
      linkRatePct,
      packsLinkingDecisions,
      decisionsComplete,
      decisionCompletenessPct,
      avgAssetAgeDays,
      stalePct,
      topAuthorShare,
      knowledgeCapturedChars,
    },
    modeledInputs,
  };
}

// Context-pack + decision total counters kept at the bottom so the big fetch
// reads top-down; both branch on dialect like the rest.
async function countContextPacks(handle: Handle, source: 'agent' | 'bridge_auto'): Promise<number> {
  if (handle.kind === 'sqlite') {
    const cp = sqliteSchema.contextPacks;
    const rows = await handle.db.select({ n: count() }).from(cp).where(eq(cp.source, source));
    return Number(rows[0]?.n ?? 0);
  }
  const cp = postgresSchema.contextPacks;
  const rows = await handle.db.select({ n: count() }).from(cp).where(eq(cp.source, source));
  return Number(rows[0]?.n ?? 0);
}

async function countDecisionsTotal(handle: Handle): Promise<number> {
  if (handle.kind === 'sqlite') {
    const rows = await handle.db.select({ n: count() }).from(sqliteSchema.decisions);
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await handle.db.select({ n: count() }).from(postgresSchema.decisions);
  return Number(rows[0]?.n ?? 0);
}
