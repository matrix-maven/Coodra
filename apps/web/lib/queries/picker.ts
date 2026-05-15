import { listAllActiveKillSwitches, postgresSchema, sqliteSchema } from '@coodra/db';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/picker.ts` — server-only aggregator for the
 * project picker hub at `/` (M04 Phase 2 S2b).
 *
 * Returns per-project tile data + a "last activity" timestamp per
 * project. The picker uses these to render its card grid.
 *
 * Query strategy: ONE projects row read + N count queries (one per
 * project per metric). At < 50 projects (the realistic ceiling for a
 * developer's local SQLite), this is cheaper than building a single
 * giant LEFT JOIN that's harder to read. If a real production team
 * mode hits 500+ projects, swap to the JOIN — but not yet.
 */

export interface PickerProjectTile {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly orgId: string;
  readonly activeRuns: number;
  readonly denials24h: number;
  readonly activeKillSwitches: number;
  readonly lastActivityAt: string | null; // ISO of most recent run.startedAt; null if no runs
  readonly statusDot: 'green' | 'amber' | 'red' | 'gray';
}

export interface PickerSnapshot {
  readonly projects: ReadonlyArray<PickerProjectTile>;
  readonly mode: 'solo' | 'team';
  readonly fetchedAt: string;
}

const SENTINEL_PROJECT_SLUGS: ReadonlySet<string> = new Set(['__global__']);

export async function fetchPickerSnapshot(): Promise<PickerSnapshot> {
  const handle = createWebDb();
  const mode = (process.env.COODRA_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';
  const allProjects = await selectAllProjects(handle);
  const projects = allProjects.filter((p) => !SENTINEL_PROJECT_SLUGS.has(p.slug));
  if (projects.length === 0) {
    return { projects: [], mode, fetchedAt: new Date().toISOString() };
  }

  const projectIds = projects.map((p) => p.id);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [activeRunsByProject, denialsByProject, killSwitchByTarget, lastActivityByProject] = await Promise.all([
    countActiveRunsByProject(handle, projectIds),
    countDenialsByProject(handle, projectIds, since),
    listKillSwitchesAffectingProjects(handle, new Set(projects.map((p) => p.slug))),
    lastRunStartedAtByProject(handle, projectIds),
  ]);

  const tiles: PickerProjectTile[] = projects.map((p) => {
    const activeRuns = activeRunsByProject.get(p.id) ?? 0;
    const denials24h = denialsByProject.get(p.id) ?? 0;
    const activeKillSwitches = killSwitchByTarget.get(p.slug) ?? 0;
    const lastActivityAt = lastActivityByProject.get(p.id) ?? null;
    const statusDot: 'green' | 'amber' | 'red' | 'gray' = (() => {
      if (denials24h > 0) return 'red';
      if (activeKillSwitches > 0) return 'amber';
      if (activeRuns > 0) return 'green';
      return 'gray';
    })();
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      orgId: p.orgId,
      activeRuns,
      denials24h,
      activeKillSwitches,
      lastActivityAt: lastActivityAt === null ? null : lastActivityAt.toISOString(),
      statusDot,
    };
  });

  // Sort by lastActivityAt desc (most recent first); projects with no activity sink to the end.
  tiles.sort((a, b) => {
    if (a.lastActivityAt === null && b.lastActivityAt === null) return a.slug.localeCompare(b.slug);
    if (a.lastActivityAt === null) return 1;
    if (b.lastActivityAt === null) return -1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });

  return { projects: tiles, mode, fetchedAt: new Date().toISOString() };
}

interface ProjectCore {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly orgId: string;
}

async function selectAllProjects(handle: ReturnType<typeof createWebDb>): Promise<ProjectCore[]> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.projects;
    const rows = await handle.db
      .select({ id: t.id, slug: t.slug, name: t.name, orgId: t.orgId })
      .from(t)
      .orderBy(t.slug);
    return rows;
  }
  const t = postgresSchema.projects;
  const rows = await handle.db.select({ id: t.id, slug: t.slug, name: t.name, orgId: t.orgId }).from(t).orderBy(t.slug);
  return rows;
}

async function countActiveRunsByProject(
  handle: ReturnType<typeof createWebDb>,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const result = new Map<string, number>();
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db
      .select({ projectId: t.projectId, n: count() })
      .from(t)
      .where(and(eq(t.status, 'in_progress'), inArray(t.projectId, [...projectIds])))
      .groupBy(t.projectId);
    for (const r of rows) result.set(r.projectId, Number(r.n));
    return result;
  }
  const t = postgresSchema.runs;
  const rows = await handle.db
    .select({ projectId: t.projectId, n: count() })
    .from(t)
    .where(and(eq(t.status, 'in_progress'), inArray(t.projectId, [...projectIds])))
    .groupBy(t.projectId);
  for (const r of rows) result.set(r.projectId, Number(r.n));
  return result;
}

async function countDenialsByProject(
  handle: ReturnType<typeof createWebDb>,
  projectIds: ReadonlyArray<string>,
  since: Date,
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const result = new Map<string, number>();
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.policyDecisions;
    const rows = await handle.db
      .select({ projectId: t.projectId, n: count() })
      .from(t)
      .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, since), inArray(t.projectId, [...projectIds])))
      .groupBy(t.projectId);
    for (const r of rows) result.set(r.projectId, Number(r.n));
    return result;
  }
  const t = postgresSchema.policyDecisions;
  const rows = await handle.db
    .select({ projectId: t.projectId, n: count() })
    .from(t)
    .where(and(eq(t.permissionDecision, 'deny'), gt(t.createdAt, since), inArray(t.projectId, [...projectIds])))
    .groupBy(t.projectId);
  for (const r of rows) result.set(r.projectId, Number(r.n));
  return result;
}

async function listKillSwitchesAffectingProjects(
  handle: ReturnType<typeof createWebDb>,
  projectSlugs: ReadonlySet<string>,
): Promise<Map<string, number>> {
  // Kill switches don't have a project_id FK; they match by `scope` +
  // `target` tuple. For the picker we show: any switch with
  // scope='project' AND target matching this project's slug.
  // (Global / tool / agent_type switches affect every project — those
  // are surfaced workspace-wide, not per project, so we exclude here.)
  const all = await listAllActiveKillSwitches(handle);
  const counts = new Map<string, number>();
  for (const ks of all) {
    if (ks.scope !== 'project') continue;
    if (ks.target === null) continue;
    if (!projectSlugs.has(ks.target)) continue;
    counts.set(ks.target, (counts.get(ks.target) ?? 0) + 1);
  }
  return counts;
}

async function lastRunStartedAtByProject(
  handle: ReturnType<typeof createWebDb>,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, Date>> {
  if (projectIds.length === 0) return new Map();
  const result = new Map<string, Date>();
  // We grab the latest run per project. SQLite + Drizzle don't support
  // window functions cleanly via the query builder; doing a simple
  // ORDER BY + per-project tracking on the JS side is fine at this
  // scale (50 projects × N runs each, but we only need the top per
  // project so we cap at 500 rows total).
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.runs;
    const rows = await handle.db
      .select({ projectId: t.projectId, startedAt: t.startedAt })
      .from(t)
      .where(inArray(t.projectId, [...projectIds]))
      .orderBy(desc(t.startedAt))
      .limit(500);
    for (const r of rows) {
      if (!result.has(r.projectId)) result.set(r.projectId, r.startedAt);
    }
    return result;
  }
  const t = postgresSchema.runs;
  const rows = await handle.db
    .select({ projectId: t.projectId, startedAt: t.startedAt })
    .from(t)
    .where(inArray(t.projectId, [...projectIds]))
    .orderBy(desc(t.startedAt))
    .limit(500);
  for (const r of rows) {
    if (!result.has(r.projectId)) result.set(r.projectId, r.startedAt);
  }
  return result;
}
