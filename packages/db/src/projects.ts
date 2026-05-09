import { and, asc, count, eq, isNull, max, ne, or } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { GLOBAL_PROJECT_ID } from './ensure-global-project.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/projects` — admin-side helpers for the
 * `projects` table. Backs Module 08b S10's
 * `contextos project {list, show, reset}` CLI surface.
 *
 * Read paths (`listProjects`, `getProjectByIdentifier`):
 * pure SELECTs with optional joins for run-count + last-run.
 *
 * Write path (`resetProject`):
 *   - DELETEs every per-run audit row for the project (runs,
 *     run_events, decisions, policy_decisions, context_packs).
 *   - Optionally preserves policies + policy_rules (`keepPolicies`,
 *     default true). The user typically wants to wipe runs but keep
 *     their custom rules.
 *   - Refuses to reset the `__global__` sentinel — losing it would
 *     break F7 (the audit-fallback project for unregistered cwds).
 *   - Returns deletion counts so the CLI can print "deleted N rows
 *     across 5 tables".
 */

export interface ProjectListRow {
  readonly id: string;
  readonly slug: string;
  readonly orgId: string;
  readonly name: string;
  /**
   * Absolute filesystem path of the project root (added 0010_projects_cwd).
   * Null on pre-2026-05-08 rows where the bridge / CLI never recorded the
   * project's cwd. Web app callers fall back to `process.cwd()` in that case.
   */
  readonly cwd: string | null;
  readonly createdAt: Date;
  readonly runCount: number;
  readonly lastRunAt: Date | null;
}

export interface ProjectDetailRow extends ProjectListRow {
  readonly recentRuns: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly agentType: string;
    readonly status: string;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
  }>;
  readonly statusCounts: Readonly<Record<string, number>>;
}

export interface ResetProjectOptions {
  readonly keepPolicies?: boolean;
}

export interface ResetProjectResult {
  readonly projectId: string;
  readonly runsDeleted: number;
  readonly runEventsDeleted: number;
  readonly policyDecisionsDeleted: number;
  readonly decisionsDeleted: number;
  readonly contextPacksDeleted: number;
  readonly killSwitchesDeleted: number;
  readonly policiesDeleted: number;
  readonly policyRulesDeleted: number;
}

/**
 * List every project, with run-count + last-run-at via join. Returns
 * the `__global__` sentinel too — the CLI may filter it out for
 * `project list` display, but admins occasionally want to see it.
 */
export async function listProjects(db: DbHandle): Promise<ProjectListRow[]> {
  if (db.kind === 'sqlite') {
    const projects = sqliteSchema.projects;
    const runs = sqliteSchema.runs;
    const rows = await db.db.select().from(projects).orderBy(asc(projects.slug));
    const out: ProjectListRow[] = [];
    for (const p of rows) {
      const stats = await db.db
        .select({ n: count(), maxStarted: max(runs.startedAt) })
        .from(runs)
        .where(eq(runs.projectId, p.id));
      const stat = stats[0];
      out.push({
        id: p.id,
        slug: p.slug,
        orgId: p.orgId,
        name: p.name,
        cwd: p.cwd,
        createdAt: p.createdAt,
        runCount: stat?.n ?? 0,
        lastRunAt: stat?.maxStarted ?? null,
      });
    }
    return out;
  }

  const projects = postgresSchema.projects;
  const runs = postgresSchema.runs;
  const rows = await db.db.select().from(projects).orderBy(asc(projects.slug));
  const out: ProjectListRow[] = [];
  for (const p of rows) {
    const stats = await db.db
      .select({ n: count(), maxStarted: max(runs.startedAt) })
      .from(runs)
      .where(eq(runs.projectId, p.id));
    const stat = stats[0];
    out.push({
      id: p.id,
      slug: p.slug,
      orgId: p.orgId,
      name: p.name,
      cwd: p.cwd,
      createdAt: p.createdAt,
      runCount: stat?.n ?? 0,
      lastRunAt: stat?.maxStarted ?? null,
    });
  }
  return out;
}

/**
 * Look up one project by id OR slug. Returns null when neither matches.
 * Detail variant: bundles the last 5 runs + a status histogram.
 */
export async function getProjectByIdentifier(db: DbHandle, identifier: string): Promise<ProjectDetailRow | null> {
  if (identifier.length === 0) return null;

  if (db.kind === 'sqlite') {
    const projects = sqliteSchema.projects;
    const runs = sqliteSchema.runs;
    const rows = await db.db
      .select()
      .from(projects)
      .where(or(eq(projects.id, identifier), eq(projects.slug, identifier)))
      .limit(1);
    if (rows.length === 0) return null;
    const p = rows[0];
    if (p === undefined) return null;
    const stats = await db.db
      .select({ n: count(), maxStarted: max(runs.startedAt) })
      .from(runs)
      .where(eq(runs.projectId, p.id));
    const stat = stats[0];
    const recentRuns = await db.db
      .select()
      .from(runs)
      .where(eq(runs.projectId, p.id))
      .orderBy(asc(runs.startedAt))
      .limit(5);
    const allRunsForCount = await db.db.select({ status: runs.status }).from(runs).where(eq(runs.projectId, p.id));
    const statusCounts: Record<string, number> = {};
    for (const r of allRunsForCount) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }
    return {
      id: p.id,
      slug: p.slug,
      orgId: p.orgId,
      name: p.name,
      cwd: p.cwd,
      createdAt: p.createdAt,
      runCount: stat?.n ?? 0,
      lastRunAt: stat?.maxStarted ?? null,
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        agentType: r.agentType,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
      })),
      statusCounts,
    };
  }

  const projects = postgresSchema.projects;
  const runs = postgresSchema.runs;
  const rows = await db.db
    .select()
    .from(projects)
    .where(or(eq(projects.id, identifier), eq(projects.slug, identifier)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];
  if (p === undefined) return null;
  const stats = await db.db
    .select({ n: count(), maxStarted: max(runs.startedAt) })
    .from(runs)
    .where(eq(runs.projectId, p.id));
  const stat = stats[0];
  const recentRuns = await db.db
    .select()
    .from(runs)
    .where(eq(runs.projectId, p.id))
    .orderBy(asc(runs.startedAt))
    .limit(5);
  const allRunsForCount = await db.db.select({ status: runs.status }).from(runs).where(eq(runs.projectId, p.id));
  const statusCounts: Record<string, number> = {};
  for (const r of allRunsForCount) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  }
  return {
    id: p.id,
    slug: p.slug,
    orgId: p.orgId,
    name: p.name,
    cwd: p.cwd,
    createdAt: p.createdAt,
    runCount: stat?.n ?? 0,
    lastRunAt: stat?.maxStarted ?? null,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      agentType: r.agentType,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    })),
    statusCounts,
  };
}

/**
 * Wipe every per-run audit row for the project. Optionally also
 * deletes the project's policies + policy_rules + kill_switches
 * (when `keepPolicies=false`).
 *
 * Order matters because of FK constraints (no ON DELETE CASCADE on
 * most tables): delete leaves before parents. Specifically:
 *
 *   1. policy_decisions (FK → runs.id, runs.project_id, policy_rules.id)
 *   2. run_events       (FK → runs.id [ON DELETE SET NULL])
 *   3. decisions        (FK → runs.id [ON DELETE SET NULL])
 *   4. context_packs    (FK → runs.id, runs.project_id)
 *   5. runs             (FK → projects.id)
 *   6. (optional) kill_switches with target=projectId where scope='project'
 *   7. (optional) policy_rules → policies → owned by this project
 *
 * Refuses to reset the `__global__` sentinel — losing it breaks F7.
 *
 * Returns deletion counts per table for the CLI to display.
 */
export async function resetProject(
  db: DbHandle,
  projectId: string,
  options: ResetProjectOptions = {},
): Promise<ResetProjectResult> {
  if (projectId === GLOBAL_PROJECT_ID) {
    throw new Error(
      `resetProject: refusing to reset the '${GLOBAL_PROJECT_ID}' sentinel project — losing it breaks the audit-fallback path for unregistered cwds (F7)`,
    );
  }

  const keepPolicies = options.keepPolicies ?? true;

  if (db.kind === 'sqlite') {
    const s = sqliteSchema;
    const policyDecisionsResult = (await db.db
      .delete(s.policyDecisions)
      .where(eq(s.policyDecisions.projectId, projectId))) as { changes?: number };
    // run_events FK → runs.id ON DELETE SET NULL, but we want them GONE for
    // this project. Since run_events has no project_id column, we delete by
    // joining through runs.id. Use a sub-select.
    const runIdsRows = await db.db.select({ id: s.runs.id }).from(s.runs).where(eq(s.runs.projectId, projectId));
    let runEventsDeleted = 0;
    let decisionsDeleted = 0;
    if (runIdsRows.length > 0) {
      const runIds = runIdsRows.map((r) => r.id);
      // Bulk-delete via prepared statement to avoid building a giant IN list.
      const placeholders = runIds.map(() => '?').join(',');
      const evResult = db.raw.prepare(`DELETE FROM run_events WHERE run_id IN (${placeholders})`).run(...runIds);
      runEventsDeleted = evResult.changes ?? 0;
      const decResult = db.raw.prepare(`DELETE FROM decisions WHERE run_id IN (${placeholders})`).run(...runIds);
      decisionsDeleted = decResult.changes ?? 0;
    }
    const contextPacksResult = (await db.db.delete(s.contextPacks).where(eq(s.contextPacks.projectId, projectId))) as {
      changes?: number;
    };
    const runsResult = (await db.db.delete(s.runs).where(eq(s.runs.projectId, projectId))) as { changes?: number };

    let killSwitchesDeleted = 0;
    let policiesDeleted = 0;
    let policyRulesDeleted = 0;
    if (!keepPolicies) {
      const ksResult = (await db.db
        .delete(s.killSwitches)
        .where(and(eq(s.killSwitches.scope, 'project'), eq(s.killSwitches.target, projectId)))) as { changes?: number };
      killSwitchesDeleted = ksResult.changes ?? 0;
      // Find policies for this project, delete their rules, then delete policies.
      const policyIdRows = await db.db
        .select({ id: s.policies.id })
        .from(s.policies)
        .where(eq(s.policies.projectId, projectId));
      if (policyIdRows.length > 0) {
        const policyIds = policyIdRows.map((r) => r.id);
        const ph = policyIds.map(() => '?').join(',');
        const rulesResult = db.raw.prepare(`DELETE FROM policy_rules WHERE policy_id IN (${ph})`).run(...policyIds);
        policyRulesDeleted = rulesResult.changes ?? 0;
        const policiesResult = db.raw.prepare(`DELETE FROM policies WHERE id IN (${ph})`).run(...policyIds);
        policiesDeleted = policiesResult.changes ?? 0;
      }
    }

    return {
      projectId,
      runsDeleted: runsResult.changes ?? 0,
      runEventsDeleted,
      policyDecisionsDeleted: policyDecisionsResult.changes ?? 0,
      decisionsDeleted,
      contextPacksDeleted: contextPacksResult.changes ?? 0,
      killSwitchesDeleted,
      policiesDeleted,
      policyRulesDeleted,
    };
  }

  // postgres
  const p = postgresSchema;
  const policyDecisionsResult = await db.db
    .delete(p.policyDecisions)
    .where(eq(p.policyDecisions.projectId, projectId))
    .returning({ id: p.policyDecisions.id });
  const runIdsRows = await db.db.select({ id: p.runs.id }).from(p.runs).where(eq(p.runs.projectId, projectId));
  let runEventsDeleted = 0;
  let decisionsDeleted = 0;
  if (runIdsRows.length > 0) {
    const runIds = runIdsRows.map((r) => r.id);
    const evDel = await db.db
      .delete(p.runEvents)
      .where(or(...runIds.map((rid) => eq(p.runEvents.runId, rid))))
      .returning({ id: p.runEvents.id });
    runEventsDeleted = evDel.length;
    const decDel = await db.db
      .delete(p.decisions)
      .where(or(...runIds.map((rid) => eq(p.decisions.runId, rid))))
      .returning({ id: p.decisions.id });
    decisionsDeleted = decDel.length;
  }
  const contextPacksResult = await db.db
    .delete(p.contextPacks)
    .where(eq(p.contextPacks.projectId, projectId))
    .returning({ id: p.contextPacks.id });
  const runsResult = await db.db.delete(p.runs).where(eq(p.runs.projectId, projectId)).returning({ id: p.runs.id });

  let killSwitchesDeleted = 0;
  let policiesDeleted = 0;
  let policyRulesDeleted = 0;
  if (!keepPolicies) {
    const ksDel = await db.db
      .delete(p.killSwitches)
      .where(and(eq(p.killSwitches.scope, 'project'), eq(p.killSwitches.target, projectId)))
      .returning({ id: p.killSwitches.id });
    killSwitchesDeleted = ksDel.length;
    const policyIdRows = await db.db
      .select({ id: p.policies.id })
      .from(p.policies)
      .where(eq(p.policies.projectId, projectId));
    if (policyIdRows.length > 0) {
      const policyIds = policyIdRows.map((r) => r.id);
      const rulesDel = await db.db
        .delete(p.policyRules)
        .where(or(...policyIds.map((id) => eq(p.policyRules.policyId, id))))
        .returning({ id: p.policyRules.id });
      policyRulesDeleted = rulesDel.length;
      const policiesDel = await db.db
        .delete(p.policies)
        .where(or(...policyIds.map((id) => eq(p.policies.id, id))))
        .returning({ id: p.policies.id });
      policiesDeleted = policiesDel.length;
    }
  }

  return {
    projectId,
    runsDeleted: runsResult.length,
    runEventsDeleted,
    policyDecisionsDeleted: policyDecisionsResult.length,
    decisionsDeleted,
    contextPacksDeleted: contextPacksResult.length,
    killSwitchesDeleted,
    policiesDeleted,
    policyRulesDeleted,
  };
}

void isNull;
void ne;

// ---------------------------------------------------------------------------
// renameProject (M04 Phase 2 S14)
// ---------------------------------------------------------------------------

export interface RenameProjectArgs {
  readonly projectId: string;
  readonly newSlug: string;
}

export type RenameProjectResult =
  | { readonly status: 'renamed'; readonly projectId: string; readonly oldSlug: string; readonly newSlug: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'sentinel_locked' }
  | { readonly status: 'slug_taken'; readonly newSlug: string };

const SLUG_RE_LIB = /^[a-z0-9_-]+$/;

export async function renameProject(db: DbHandle, args: RenameProjectArgs): Promise<RenameProjectResult> {
  if (args.projectId === GLOBAL_PROJECT_ID) return { status: 'sentinel_locked' };
  const newSlug = args.newSlug.trim();
  if (!SLUG_RE_LIB.test(newSlug)) {
    return { status: 'slug_taken', newSlug };
  }
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.projects;
    const rows = await db.db.select().from(t).where(eq(t.id, args.projectId)).limit(1);
    const cur = rows[0];
    if (cur === undefined) return { status: 'not_found' };
    const oldSlug = cur.slug;
    if (oldSlug === newSlug) {
      return { status: 'renamed', projectId: args.projectId, oldSlug, newSlug };
    }
    const taken = await db.db.select({ id: t.id }).from(t).where(eq(t.slug, newSlug)).limit(1);
    if (taken[0] !== undefined && taken[0].id !== args.projectId) {
      return { status: 'slug_taken', newSlug };
    }
    await db.db.update(t).set({ slug: newSlug, name: newSlug, updatedAt: new Date() }).where(eq(t.id, args.projectId));
    return { status: 'renamed', projectId: args.projectId, oldSlug, newSlug };
  }
  const t = postgresSchema.projects;
  const rows = await db.db.select().from(t).where(eq(t.id, args.projectId)).limit(1);
  const cur = rows[0];
  if (cur === undefined) return { status: 'not_found' };
  const oldSlug = cur.slug;
  if (oldSlug === newSlug) {
    return { status: 'renamed', projectId: args.projectId, oldSlug, newSlug };
  }
  const taken = await db.db.select({ id: t.id }).from(t).where(eq(t.slug, newSlug)).limit(1);
  if (taken[0] !== undefined && taken[0].id !== args.projectId) {
    return { status: 'slug_taken', newSlug };
  }
  await db.db.update(t).set({ slug: newSlug, name: newSlug, updatedAt: new Date() }).where(eq(t.id, args.projectId));
  return { status: 'renamed', projectId: args.projectId, oldSlug, newSlug };
}

// ---------------------------------------------------------------------------
// deleteProject (M04 Phase 2 S14)
// ---------------------------------------------------------------------------

export interface DeleteProjectResult {
  readonly status: 'deleted' | 'not_found' | 'sentinel_locked';
  readonly projectId: string;
  /** Counts from the cascading reset that runs first. */
  readonly cascade?: ResetProjectResult;
}

export async function deleteProject(db: DbHandle, projectId: string): Promise<DeleteProjectResult> {
  if (projectId === GLOBAL_PROJECT_ID) return { status: 'sentinel_locked', projectId };
  // First wipe everything per-project (including policies + kill switches).
  let cascade: ResetProjectResult;
  try {
    cascade = await resetProject(db, projectId, { keepPolicies: false });
  } catch {
    return { status: 'not_found', projectId };
  }
  if (db.kind === 'sqlite') {
    const t = sqliteSchema.projects;
    const r = (await db.db.delete(t).where(eq(t.id, projectId))) as { changes?: number };
    if ((r.changes ?? 0) === 0) return { status: 'not_found', projectId, cascade };
    return { status: 'deleted', projectId, cascade };
  }
  const t = postgresSchema.projects;
  const r = await db.db.delete(t).where(eq(t.id, projectId)).returning({ id: t.id });
  if (r.length === 0) return { status: 'not_found', projectId, cascade };
  return { status: 'deleted', projectId, cascade };
}

// ---------------------------------------------------------------------------
// readProjectExport (M04 Phase 2 S14) — JSONL stream payload
// ---------------------------------------------------------------------------

export interface ProjectExportRow {
  readonly type: 'project' | 'run' | 'run_event' | 'decision' | 'policy_decision' | 'context_pack';
  readonly data: unknown;
}

/**
 * Streams every per-project audit row as a single ordered list,
 * tagged by type. Caller serializes each entry as one JSON object per
 * line ("JSONL"). Keeps per-row memory bounded (chunked SELECTs not
 * yet — projects are typically small).
 */
export async function readProjectExport(db: DbHandle, projectId: string): Promise<ProjectExportRow[]> {
  if (db.kind === 'sqlite') {
    const s = sqliteSchema;
    const proj = await db.db.select().from(s.projects).where(eq(s.projects.id, projectId)).limit(1);
    const project = proj[0];
    if (project === undefined) return [];
    const runs = await db.db
      .select()
      .from(s.runs)
      .where(eq(s.runs.projectId, projectId))
      .orderBy(asc(s.runs.startedAt));
    const runIds = runs.map((r) => r.id);
    let runEvents: unknown[] = [];
    let decisions: unknown[] = [];
    if (runIds.length > 0) {
      const ph = runIds.map(() => '?').join(',');
      runEvents = db.raw
        .prepare(`SELECT * FROM run_events WHERE run_id IN (${ph}) ORDER BY created_at ASC`)
        .all(...runIds) as unknown[];
      decisions = db.raw
        .prepare(`SELECT * FROM decisions WHERE run_id IN (${ph}) ORDER BY created_at ASC`)
        .all(...runIds) as unknown[];
    }
    const policyDecisions = await db.db
      .select()
      .from(s.policyDecisions)
      .where(eq(s.policyDecisions.projectId, projectId))
      .orderBy(asc(s.policyDecisions.createdAt));
    const contextPacks = await db.db
      .select()
      .from(s.contextPacks)
      .where(eq(s.contextPacks.projectId, projectId))
      .orderBy(asc(s.contextPacks.createdAt));
    return [
      { type: 'project', data: project },
      ...runs.map((r) => ({ type: 'run' as const, data: r })),
      ...runEvents.map((d) => ({ type: 'run_event' as const, data: d })),
      ...decisions.map((d) => ({ type: 'decision' as const, data: d })),
      ...policyDecisions.map((d) => ({ type: 'policy_decision' as const, data: d })),
      ...contextPacks.map((d) => ({ type: 'context_pack' as const, data: d })),
    ];
  }
  const p = postgresSchema;
  const proj = await db.db.select().from(p.projects).where(eq(p.projects.id, projectId)).limit(1);
  const project = proj[0];
  if (project === undefined) return [];
  const runs = await db.db.select().from(p.runs).where(eq(p.runs.projectId, projectId)).orderBy(asc(p.runs.startedAt));
  const runIds = runs.map((r) => r.id);
  let runEvents: unknown[] = [];
  let decisions: unknown[] = [];
  if (runIds.length > 0) {
    runEvents = await db.db
      .select()
      .from(p.runEvents)
      .where(or(...runIds.map((id) => eq(p.runEvents.runId, id))))
      .orderBy(asc(p.runEvents.createdAt));
    decisions = await db.db
      .select()
      .from(p.decisions)
      .where(or(...runIds.map((id) => eq(p.decisions.runId, id))))
      .orderBy(asc(p.decisions.createdAt));
  }
  const policyDecisions = await db.db
    .select()
    .from(p.policyDecisions)
    .where(eq(p.policyDecisions.projectId, projectId))
    .orderBy(asc(p.policyDecisions.createdAt));
  const contextPacks = await db.db
    .select()
    .from(p.contextPacks)
    .where(eq(p.contextPacks.projectId, projectId))
    .orderBy(asc(p.contextPacks.createdAt));
  return [
    { type: 'project', data: project },
    ...runs.map((r) => ({ type: 'run' as const, data: r })),
    ...runEvents.map((d) => ({ type: 'run_event' as const, data: d })),
    ...decisions.map((d) => ({ type: 'decision' as const, data: d })),
    ...policyDecisions.map((d) => ({ type: 'policy_decision' as const, data: d })),
    ...contextPacks.map((d) => ({ type: 'context_pack' as const, data: d })),
  ];
}
