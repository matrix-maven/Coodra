import { randomUUID } from 'node:crypto';

import { type DbHandle, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger, generateRunKey } from '@coodra/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { ToolContext } from '../../framework/tool-context.js';
import { SOLO_IDENTITY } from '../../lib/auth.js';
import type { GetRunIdInput, GetRunIdOutput } from './schema.js';

/**
 * Handler factory for `coodra__get_run_id`.
 *
 * Factory shape (not a bare function like `ping`) because the
 * handler's asymmetric solo/team behaviour per user directive Q1
 * (2026-04-24) requires `mode` at construction time. The factory
 * closes over `deps.db` (the `DbHandle` from `dbClient.asInternalHandle()`)
 * and `deps.mode` (`solo` | `team`), so the closure is the only
 * place either value is read — handler invocation itself is purely
 * input-driven.
 *
 * Behaviour (§24.4 + user ruling 2026-04-24):
 *
 *   1. Resolve `projectSlug` → `projects.id`. Missing row:
 *      - Solo mode: auto-create with `{ id: uuid, slug, orgId:
 *        SOLO_IDENTITY.orgId, name: slug }`. Zero-config ergonomics
 *        for the local-dev case where no Web App onboarding ran.
 *      - Team mode: return `{ ok: false, error: 'project_not_found',
 *        howToFix: ... }` soft-failure. Throwing would surface as a
 *        generic "tool failed"; the soft-failure carries
 *        user-actionable guidance.
 *
 *   2. SELECT most recent `runs` row for (projectId, sessionId).
 *      - If found → return { ok: true, runId, startedAt }. Emit a
 *        WARN when `status !== 'in_progress'` so we see the
 *        non-in-progress-return case in ops logs; trigger for a
 *        future migration-0003 if volume crosses a threshold
 *        (decisions-log 2026-04-24 "Q3 approved with WARN").
 *      - If not found → INSERT with `generateRunKey({ projectId,
 *        sessionId })` as the row id. `onConflictDoNothing` on the
 *        `(project_id, session_id)` unique index handles the
 *        concurrent-create race; when no row returns, re-SELECT to
 *        fetch the winner.
 *
 *   3. `agentType` stamped onto the new `runs` row comes from
 *      `ctx.agentType`, populated by the stdio transport from the
 *      MCP `initialize.clientInfo.name` handshake (S8 user
 *      directive Q2).
 *
 *   4. `mode` stamped onto the new row is the factory's `deps.mode`
 *      — the process's boot-time `COODRA_MODE`.
 *
 *   5. `startedAt` comes from the DB's `DEFAULT (unixepoch())`
 *      clause, surfaced via the INSERT RETURNING. Handler never
 *      reads the wall clock directly; `ctx.now()` is available but
 *      unused here because the canonical timestamp is the DB's.
 *
 * Idempotency of the tool registration-framework key (separate from
 * the `runs.id` key above): `get_run_id:{projectSlug}:{sessionId}`
 * per user directive Q5 2026-04-24 — uses caller-supplied
 * `projectSlug` (not internal-resolved `projectId`) so retries with
 * the same input dedupe regardless of whether the solo-auto-create
 * branch ran.
 */

const handlerLogger = createLogger('mcp-server.tool.get_run_id');

export interface GetRunIdHandlerDeps {
  readonly db: DbHandle;
  readonly mode: 'solo' | 'team';
}

/** Row shape shared by both dialects' `runs` table (structural). */
interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly startedAt: Date;
}

async function resolveProjectId(
  deps: GetRunIdHandlerDeps,
  projectSlug: string,
): Promise<{ readonly kind: 'found'; readonly projectId: string } | { readonly kind: 'missing' }> {
  if (deps.db.kind === 'sqlite') {
    const rows = await deps.db.db
      .select({ id: sqliteSchema.projects.id })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    const found = rows[0];
    return found ? { kind: 'found', projectId: found.id } : { kind: 'missing' };
  }
  const rows = await deps.db.db
    .select({ id: postgresSchema.projects.id })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  const found = rows[0];
  return found ? { kind: 'found', projectId: found.id } : { kind: 'missing' };
}

async function autoCreateProject(deps: GetRunIdHandlerDeps, projectSlug: string): Promise<string> {
  const projectId = `proj_${randomUUID()}`;
  const row = {
    id: projectId,
    slug: projectSlug,
    orgId: SOLO_IDENTITY.orgId ?? 'org_dev_local',
    name: projectSlug,
  };
  if (deps.db.kind === 'sqlite') {
    await deps.db.db.insert(sqliteSchema.projects).values(row).onConflictDoNothing({
      target: sqliteSchema.projects.slug,
    });
  } else {
    await deps.db.db.insert(postgresSchema.projects).values(row).onConflictDoNothing({
      target: postgresSchema.projects.slug,
    });
  }
  // onConflict may race: re-resolve to get the winning id.
  const resolved = await resolveProjectId(deps, projectSlug);
  if (resolved.kind === 'missing') {
    // Should never happen: we just inserted + onConflictDoNothing
    // should leave a row present either way. If we genuinely see
    // this, the caller will get an internal error on the next step;
    // that's the correct signal.
    handlerLogger.error(
      { event: 'get_run_id_auto_create_vanished', projectSlug, projectId },
      'auto-create followed by re-select found no row; concurrent delete?',
    );
    return projectId;
  }
  if (resolved.projectId !== projectId) {
    handlerLogger.info(
      { event: 'get_run_id_auto_create_raced', projectSlug, mineId: projectId, winnerId: resolved.projectId },
      'auto-create raced with a concurrent insert; using the winner',
    );
  } else {
    handlerLogger.info(
      { event: 'get_run_id_project_auto_created', projectSlug, projectId, orgId: row.orgId },
      'solo-mode auto-created projects row for unknown slug',
    );
  }
  return resolved.projectId;
}

// NOTE: The bridge's RunRecorder uses the leaner `lookupRunId` helper
// from @coodra/db (verification F8 closure, 2026-04-27) which returns
// just the id. This local `selectLatestRun` keeps the wider RunRow
// shape (id + status + startedAt) needed by `get_run_id` to decide
// whether to return the existing in-progress row vs mint a new one.
async function selectLatestRun(
  deps: GetRunIdHandlerDeps,
  projectId: string,
  sessionId: string,
): Promise<RunRow | null> {
  if (deps.db.kind === 'sqlite') {
    const rows = await deps.db.db
      .select({
        id: sqliteSchema.runs.id,
        status: sqliteSchema.runs.status,
        startedAt: sqliteSchema.runs.startedAt,
      })
      .from(sqliteSchema.runs)
      .where(and(eq(sqliteSchema.runs.projectId, projectId), eq(sqliteSchema.runs.sessionId, sessionId)))
      .orderBy(desc(sqliteSchema.runs.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await deps.db.db
    .select({
      id: postgresSchema.runs.id,
      status: postgresSchema.runs.status,
      startedAt: postgresSchema.runs.startedAt,
    })
    .from(postgresSchema.runs)
    .where(and(eq(postgresSchema.runs.projectId, projectId), eq(postgresSchema.runs.sessionId, sessionId)))
    .orderBy(desc(postgresSchema.runs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function insertRun(
  deps: GetRunIdHandlerDeps,
  row: {
    readonly id: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly agentType: string;
    readonly mode: 'solo' | 'team';
  },
): Promise<RunRow | null> {
  if (deps.db.kind === 'sqlite') {
    const inserted = await deps.db.db
      .insert(sqliteSchema.runs)
      .values({
        id: row.id,
        projectId: row.projectId,
        sessionId: row.sessionId,
        agentType: row.agentType,
        mode: row.mode,
        // status + startedAt pick up their schema defaults.
      })
      .onConflictDoNothing({ target: [sqliteSchema.runs.projectId, sqliteSchema.runs.sessionId] })
      .returning({
        id: sqliteSchema.runs.id,
        status: sqliteSchema.runs.status,
        startedAt: sqliteSchema.runs.startedAt,
      });
    return inserted[0] ?? null;
  }
  const inserted = await deps.db.db
    .insert(postgresSchema.runs)
    .values({
      id: row.id,
      projectId: row.projectId,
      sessionId: row.sessionId,
      agentType: row.agentType,
      mode: row.mode,
    })
    .onConflictDoNothing({ target: [postgresSchema.runs.projectId, postgresSchema.runs.sessionId] })
    .returning({
      id: postgresSchema.runs.id,
      status: postgresSchema.runs.status,
      startedAt: postgresSchema.runs.startedAt,
    });
  return inserted[0] ?? null;
}

export function createGetRunIdHandler(deps: GetRunIdHandlerDeps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createGetRunIdHandler requires a deps object');
  }
  if (!deps.db || typeof deps.db !== 'object' || !('kind' in deps.db)) {
    throw new TypeError('createGetRunIdHandler: deps.db must be a DbHandle');
  }
  if (deps.mode !== 'solo' && deps.mode !== 'team') {
    throw new TypeError(`createGetRunIdHandler: deps.mode must be 'solo' | 'team', got '${String(deps.mode)}'`);
  }

  return async function getRunIdHandler(input: GetRunIdInput, ctx: ToolContext): Promise<GetRunIdOutput> {
    // F9 + F10 closure (verification 2026-04-27): when the caller
    // supplies an agentSessionId / agentType, use those as the
    // canonical session-binding values. Otherwise fall back to the
    // transport-generated ctx.sessionId / ctx.agentType (legacy
    // behaviour preserved for callers that omit the fields).
    const effectiveSessionId = input.agentSessionId ?? ctx.sessionId;
    const effectiveAgentType = input.agentType ?? ctx.agentType;

    const resolved = await resolveProjectId(deps, input.projectSlug);

    let projectId: string;
    if (resolved.kind === 'found') {
      projectId = resolved.projectId;
    } else if (deps.mode === 'solo') {
      projectId = await autoCreateProject(deps, input.projectSlug);
    } else {
      handlerLogger.info(
        {
          event: 'get_run_id_project_not_found_team',
          projectSlug: input.projectSlug,
          sessionId: effectiveSessionId,
          agentType: effectiveAgentType,
        },
        'team-mode: project slug not registered — returning soft-failure',
      );
      return {
        ok: false,
        error: 'project_not_found',
        howToFix: 'Register this project via the Web App or run `coodra init` in the project root before retrying.',
      };
    }

    // Existing-run path.
    const existing = await selectLatestRun(deps, projectId, effectiveSessionId);
    if (existing) {
      if (existing.status !== 'in_progress') {
        handlerLogger.warn(
          {
            event: 'get_run_id_returning_non_in_progress',
            runId: existing.id,
            sessionId: effectiveSessionId,
            status: existing.status,
          },
          'get_run_id returning non-in-progress run; if this WARN grows common, consider migration 0003 to relax the runs unique index to (project_id, session_id, status)',
        );
      }
      return {
        ok: true,
        runId: existing.id,
        startedAt: existing.startedAt.toISOString(),
      };
    }

    // Create path.
    const newId = generateRunKey({ projectId, sessionId: effectiveSessionId });
    const inserted = await insertRun(deps, {
      id: newId,
      projectId,
      sessionId: effectiveSessionId,
      agentType: effectiveAgentType,
      mode: deps.mode,
    });
    if (inserted) {
      handlerLogger.info(
        {
          event: 'get_run_id_created',
          runId: inserted.id,
          projectId,
          sessionId: effectiveSessionId,
          agentType: effectiveAgentType,
          mode: deps.mode,
          // Surface whether the canonical fields came from input or ctx
          // so ops can see adoption of the F9 contract.
          source: input.agentSessionId !== undefined ? 'agent_supplied' : 'transport_default',
        },
        'get_run_id created a new runs row',
      );
      return {
        ok: true,
        runId: inserted.id,
        startedAt: inserted.startedAt.toISOString(),
      };
    }

    // Concurrent insert won the race — the unique index rejected us,
    // and onConflictDoNothing returned 0 rows. Re-SELECT to get the
    // winning row.
    const winner = await selectLatestRun(deps, projectId, effectiveSessionId);
    if (winner) {
      handlerLogger.info(
        {
          event: 'get_run_id_race_resolved',
          runId: winner.id,
          projectId,
          sessionId: effectiveSessionId,
        },
        'get_run_id concurrent-insert race resolved via re-SELECT',
      );
      return {
        ok: true,
        runId: winner.id,
        startedAt: winner.startedAt.toISOString(),
      };
    }

    // Truly unreachable: insert returned no row AND re-SELECT found
    // no row — would require the row to be deleted between the two
    // statements. Log and throw so the generic registry `handler_threw`
    // envelope surfaces.
    throw new Error(
      `get_run_id: insert returned 0 rows and re-SELECT found nothing for (projectId=${projectId}, sessionId=${effectiveSessionId})`,
    );
  };
}
