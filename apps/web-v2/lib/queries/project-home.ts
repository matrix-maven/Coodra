import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/contextos-db';
import { and, count, desc, eq, gt } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';
import { listPacks, type PackListRow, packsRoot } from '@/lib/queries/packs';

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

export interface ProjectHomePackInfo {
  /** Pack whose slug == projectSlug. The bridge auto-injects this on SessionStart. */
  readonly primary: PackListRow | null;
  /** Ancestors via meta.json:parentSlug, root-first. Resolved on the MCP side at get_feature_pack time. */
  readonly chain: ReadonlyArray<PackListRow>;
  /** True if walking the parent chain hit a slug already visited (cycle in meta.json). */
  readonly cycleDetected: boolean;
  /** Slug referenced as parent but missing from disk; null if the chain resolves cleanly. */
  readonly missingAncestor: string | null;
  /** Resolved <repo>/docs/feature-packs root for the panel's metadata strip. */
  readonly packsRoot: string;
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
  readonly pack: ProjectHomePackInfo;
}

export async function fetchProjectHomeSnapshot(args: {
  readonly projectId: string;
  readonly projectSlug: string;
  /**
   * Absolute path of the project root from `projects.cwd`. When supplied,
   * pack lookups read from `<projectCwd>/docs/feature-packs/<slug>/`. Null
   * for pre-2026-05-08 rows where the bridge / CLI never recorded the cwd
   * — the panel falls back to web-v2's process.cwd() so it still renders
   * something, but uploads should not be encouraged in that state.
   */
  readonly projectCwd?: string | null;
}): Promise<ProjectHomeSnapshot> {
  const handle = createWebDb();
  const mode = (process.env.CONTEXTOS_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';

  const [activeRunsCount, denials24hCount, activeKillSwitches, latestEvents] = await Promise.all([
    countActiveRunsForProject(handle, args.projectId),
    countDenialsLast24hForProject(handle, args.projectId),
    countKillSwitchesForProjectSlug(handle, args.projectSlug),
    fetchLatestEventsForProject(handle, args.projectId),
  ]);
  // Pack info is filesystem-only — no DB hit, no Promise.all entry.
  const pack = fetchProjectPackInfo(args.projectSlug, args.projectCwd ?? process.cwd());

  return {
    projectId: args.projectId,
    projectSlug: args.projectSlug,
    activeRuns: activeRunsCount,
    denials24h: denials24hCount,
    activeKillSwitches,
    latestEvents,
    mode,
    fetchedAt: new Date().toISOString(),
    pack,
  };
}

/**
 * Resolve the project's feature-pack situation purely from the filesystem.
 *
 * - "Primary" = the pack whose slug equals the project's slug. This is the
 *   one the bridge auto-injects on SessionStart (see
 *   `apps/hooks-bridge/src/lib/feature-pack-loader.ts:72-74`).
 * - "Chain" = root-first walk of `meta.json:parentSlug` ancestors. Only the
 *   MCP-side `get_feature_pack` walks this at runtime
 *   (`apps/mcp-server/src/lib/feature-pack.ts:330-357`); we mirror the
 *   algorithm here so the project home can preview what the agent sees.
 *
 * Sync — wraps the already-sync `listPacks()`. Safe to call inside the
 * async `fetchProjectHomeSnapshot`.
 */
export function fetchProjectPackInfo(projectSlug: string, cwd: string = process.cwd()): ProjectHomePackInfo {
  const allPacks = listPacks(cwd);
  const bySlug = new Map(allPacks.map((p) => [p.slug, p]));
  const primary = bySlug.get(projectSlug) ?? null;

  const chain: PackListRow[] = [];
  let cycleDetected = false;
  let missingAncestor: string | null = null;

  if (primary !== null && primary.parentSlug !== null) {
    const visited = new Set<string>([primary.slug]);
    let cursor: string | null = primary.parentSlug;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        cycleDetected = true;
        break;
      }
      visited.add(cursor);
      const parent = bySlug.get(cursor);
      if (parent === undefined) {
        missingAncestor = cursor;
        break;
      }
      chain.push(parent);
      cursor = parent.parentSlug;
    }
    chain.reverse(); // root-first to mirror walkAncestors output
  }

  return {
    primary,
    chain,
    cycleDetected,
    missingAncestor,
    packsRoot: packsRoot(cwd),
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
