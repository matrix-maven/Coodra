import { type DbHandle, ensureProject, postgresSchema, sqliteSchema } from '@coodra/db';
import { createLogger, generateRunKey, readCoodraProjectConfig } from '@coodra/shared';
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
 * Behaviour (§24.4 + user ruling 2026-04-24; registration guard COOD-63):
 *
 *   1. Resolve `projectSlug` → `projects.id`. Missing row, or a
 *      found row with no verified `cwd`:
 *      - Solo mode: `resolveOrRegisterProject` gates creation —
 *        proceeds only when `input.cwd` matches a real
 *        `.coodra/config.json`, or the caller passes
 *        `confirmRegister: true` after the user has explicitly
 *        agreed. Otherwise returns `{ ok: false, error:
 *        'project_not_registered', howToFix }`. Zero-config
 *        ergonomics are preserved for the legitimate case (a real
 *        project whose SessionStart hook just hasn't fired yet this
 *        turn); what's gone is silently minting a DB row for any
 *        string an agent invents when a directory was never
 *        `coodra init`'d (field report 2026-08-13 — a Devin session
 *        recorded durable decisions against a project that existed
 *        nowhere the user could see it).
 *      - Team mode: return `{ ok: false, error: 'project_not_found',
 *        howToFix: ... }` soft-failure — unchanged, already the
 *        stricter behavior. Throwing would surface as a generic
 *        "tool failed"; the soft-failure carries user-actionable
 *        guidance.
 *
 *   2. SELECT most recent `runs` row for (projectId, sessionId).
 *      - If found and `status === 'in_progress'` → return { ok: true,
 *        runId, startedAt } as-is.
 *      - If found but terminal (`completed`/`cancelled`/`failed`/
 *        `abandoned`) → resume it: UPDATE `status = 'in_progress'`,
 *        `ended_at = NULL`, then return it (2026-08-08 — a Claude Code
 *        session's own `session_id` is stable across context-compaction/
 *        continuation, so a run that spans multiple days keeps resolving
 *        to the same row; a `SessionEnd` firing once mid-session
 *        shouldn't strand every later prompt against a run that reads as
 *        "done" while still recording activity. Deliberately does NOT
 *        mint a fresh row — `(project_id, session_id)` stays the unique
 *        identity for "this session's run," by design, not as a
 *        deferred migration).
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

interface ResolvedProject {
  readonly kind: 'found';
  readonly projectId: string;
  readonly orgId: string;
  readonly cwd: string | null;
}

async function resolveProjectId(
  deps: GetRunIdHandlerDeps,
  projectSlug: string,
): Promise<ResolvedProject | { readonly kind: 'missing' }> {
  if (deps.db.kind === 'sqlite') {
    const rows = await deps.db.db
      .select({ id: sqliteSchema.projects.id, orgId: sqliteSchema.projects.orgId, cwd: sqliteSchema.projects.cwd })
      .from(sqliteSchema.projects)
      .where(eq(sqliteSchema.projects.slug, projectSlug))
      .limit(1);
    const found = rows[0];
    return found ? { kind: 'found', projectId: found.id, orgId: found.orgId, cwd: found.cwd } : { kind: 'missing' };
  }
  const rows = await deps.db.db
    .select({ id: postgresSchema.projects.id, orgId: postgresSchema.projects.orgId, cwd: postgresSchema.projects.cwd })
    .from(postgresSchema.projects)
    .where(eq(postgresSchema.projects.slug, projectSlug))
    .limit(1);
  const found = rows[0];
  return found ? { kind: 'found', projectId: found.id, orgId: found.orgId, cwd: found.cwd } : { kind: 'missing' };
}

type ProjectResolution =
  | { readonly kind: 'ok'; readonly projectId: string; readonly orgId: string }
  | { readonly kind: 'not_registered' };

/**
 * Solo-mode registration guard (COOD-63). Replaces the old
 * `autoCreateProject`, which minted a `projects` row for ANY string
 * an agent supplied as `projectSlug` — no filesystem check, `cwd`
 * left null forever. That let an agent record durable decisions
 * against a project the user never registered and could not see
 * anywhere (field report 2026-08-13, Devin + an uninitialized repo).
 *
 * A row is trusted automatically only when it already has a verified
 * `cwd` (set by `coodra init` or a prior confirmed call here) — that
 * covers the legitimate zero-config case this tool was built for: a
 * real project whose SessionStart hook simply hasn't fired yet this
 * turn. Anything else — an unknown slug, or an old row with `cwd`
 * still null — requires one of:
 *   - `input.cwd` resolves via `readCoodraProjectConfig` to a
 *     `.coodra/config.json` whose `projectSlug` matches, i.e. the
 *     directory really was `coodra init`'d; or
 *   - `input.confirmRegister === true`, i.e. the agent asked the
 *     user and got an explicit yes.
 * Either way, creation/backfill goes through the SAME `ensureProject`
 * `coodra init` itself calls — one canonical project-creation path,
 * not two divergent ones — so `cwd` gets set and this directory never
 * needs to re-confirm again.
 */
async function resolveOrRegisterProject(deps: GetRunIdHandlerDeps, input: GetRunIdInput): Promise<ProjectResolution> {
  const resolved = await resolveProjectId(deps, input.projectSlug);
  if (resolved.kind === 'found' && resolved.cwd !== null) {
    return { kind: 'ok', projectId: resolved.projectId, orgId: resolved.orgId };
  }

  let verifiedCwd: string | undefined;
  if (input.confirmRegister !== true && input.cwd !== undefined) {
    const projectConfig = await readCoodraProjectConfig(input.cwd);
    if (projectConfig !== null && projectConfig.projectSlug === input.projectSlug) {
      verifiedCwd = input.cwd;
    }
  }
  // `confirmRegister` alone is not enough: without a `cwd` to persist,
  // the created row's `cwd` would stay null and every later call would
  // re-hit this same gate forever — exactly the "nag every session"
  // failure mode this guard exists to prevent. Require both together
  // so a confirmed project is trusted from then on, agent-agnostically.
  const allowRegister = (input.confirmRegister === true && input.cwd !== undefined) || verifiedCwd !== undefined;

  if (!allowRegister) {
    handlerLogger.info(
      {
        event: 'get_run_id_project_not_registered',
        projectSlug: input.projectSlug,
        hadExistingUnverifiedRow: resolved.kind === 'found',
        confirmRegisterWithoutCwd: input.confirmRegister === true && input.cwd === undefined,
      },
      'solo-mode: project not verified via .coodra/config.json, or confirmRegister was set without cwd — returning soft-failure',
    );
    return { kind: 'not_registered' };
  }

  const persistedCwd = verifiedCwd ?? input.cwd;
  const result = await ensureProject(deps.db, {
    slug: input.projectSlug,
    orgId: SOLO_IDENTITY.orgId ?? 'org_dev_local',
    ...(persistedCwd !== undefined ? { cwd: persistedCwd } : {}),
  });
  handlerLogger.info(
    {
      event: result.created ? 'get_run_id_project_registered' : 'get_run_id_project_cwd_backfilled',
      projectSlug: input.projectSlug,
      projectId: result.id,
      via: input.confirmRegister === true ? 'confirmRegister' : 'cwd_config_match',
    },
    result.created
      ? 'solo-mode registered a new project after verification/confirmation'
      : 'solo-mode backfilled cwd onto a previously-unverified project row',
  );

  const settled = await resolveProjectId(deps, input.projectSlug);
  const orgId = settled.kind === 'found' ? settled.orgId : (SOLO_IDENTITY.orgId ?? 'org_dev_local');
  return { kind: 'ok', projectId: result.id, orgId };
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

/**
 * Resume a terminal run back to `in_progress` when the same session's
 * next prompt lands after it was already marked done — see `selectLatestRun`
 * call site for why this beats minting a new row. `ended_at` is cleared so
 * the run reads as genuinely active again, not just relabeled; a future
 * SessionEnd/cancel/complete sets both fields again same as any other run.
 */
async function resumeRun(deps: GetRunIdHandlerDeps, runId: string): Promise<void> {
  if (deps.db.kind === 'sqlite') {
    await deps.db.db
      .update(sqliteSchema.runs)
      .set({ status: 'in_progress', endedAt: null })
      .where(eq(sqliteSchema.runs.id, runId));
    return;
  }
  await deps.db.db
    .update(postgresSchema.runs)
    .set({ status: 'in_progress', endedAt: null })
    .where(eq(postgresSchema.runs.id, runId));
}

async function insertRun(
  deps: GetRunIdHandlerDeps,
  row: {
    readonly id: string;
    readonly orgId: string;
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
        orgId: row.orgId,
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
      orgId: row.orgId,
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
    // supplies an agentSessionId, use it as the canonical session-binding
    // value. Otherwise fall back to the transport-generated ctx.sessionId
    // (legacy behaviour preserved for callers that omit the field).
    const effectiveSessionId = input.agentSessionId ?? ctx.sessionId;
    // Agent-type precedence (field fix 2026-07-12): the transport-resolved
    // identity WINS when it is known. On stdio it comes from the per-agent
    // `COODRA_AGENT_TYPE` stamp `coodra init` wrote into the very config
    // entry that launched this server; on HTTP from the client's own
    // initialize handshake. The `input.agentType` param, by contrast, is
    // instruction-file text that ANY agent may parrot — AGENTS.md is a
    // de-facto cross-agent standard, so Windsurf reading a Codex-generated
    // AGENTS.md dutifully passed `agentType: "codex"` and mislabeled its
    // runs. The param stays as the fallback for transports that resolve
    // 'unknown' (e.g. manually wired configs without the env stamp).
    const effectiveAgentType = ctx.agentType !== 'unknown' ? ctx.agentType : (input.agentType ?? ctx.agentType);

    let projectId: string;
    let orgId: string;
    if (deps.mode === 'solo') {
      const resolution = await resolveOrRegisterProject(deps, input);
      if (resolution.kind === 'not_registered') {
        return {
          ok: false,
          error: 'project_not_registered',
          howToFix:
            "This directory isn't a verified Coodra project (no matching .coodra/config.json for " +
            `projectSlug "${input.projectSlug}"). Ask the user: "This repository isn't registered with Coodra ` +
            'yet — register it so I can save decisions and context for this session?" If yes: run `coodra init` ' +
            'in the project root (preferred — also writes local config), then call get_run_id again; or call ' +
            'get_run_id again immediately with BOTH cwd and confirmRegister: true (cwd is required so this ' +
            "directory won't need to be confirmed again). If no: continue the coding task normally, but do not " +
            'call get_run_id, record_decision, save_context_pack, or any other Coodra write tool again this session.',
        };
      }
      projectId = resolution.projectId;
      orgId = resolution.orgId;
    } else {
      const resolved = await resolveProjectId(deps, input.projectSlug);
      if (resolved.kind !== 'found') {
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
      projectId = resolved.projectId;
      orgId = resolved.orgId;
    }

    // Existing-run path.
    const existing = await selectLatestRun(deps, projectId, effectiveSessionId);
    if (existing) {
      if (existing.status !== 'in_progress') {
        await resumeRun(deps, existing.id);
        handlerLogger.info(
          {
            event: 'get_run_id_resumed',
            runId: existing.id,
            sessionId: effectiveSessionId,
            previousStatus: existing.status,
          },
          'get_run_id resumed a terminal run back to in_progress — same session reused after it was marked done',
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
      orgId,
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
