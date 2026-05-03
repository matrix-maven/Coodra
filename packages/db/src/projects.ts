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
