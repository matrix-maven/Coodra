import {
  createPostgresDb,
  EnsureProjectError,
  ensureProject,
  GLOBAL_ORG_ID,
  GLOBAL_PROJECT_ID,
  getProjectByIdentifier,
  listProjects,
  type ProjectDetailRow,
  type ProjectListRow,
  postgresSchema,
  type ResetProjectResult,
  resetProject,
  SOLO_ORG_ID,
} from '@coodra/db';
import { readVerifiedToken } from '@coodra/shared/auth';
import { eq } from 'drizzle-orm';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { readTeamConfig, readTeamHomeEnv } from '../lib/team-config.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

/**
 * `coodra project {list|show|reset}` — admin surface for the
 * `projects` table. Module 08b S10.
 *
 * The `__global__` sentinel is a special row used as the
 * audit-fallback FK for events arriving from cwds that have no
 * `.coodra.json`. `project list` shows it (with a `(sentinel)`
 * tag); `project show __global__` works; `project reset` REFUSES to
 * touch it because losing it would break F7's audit-fallback path.
 */

export interface ProjectListOptions {
  readonly json?: boolean;
  readonly includeGlobal?: boolean;
}

export interface ProjectShowOptions {
  readonly json?: boolean;
}

export interface ProjectResetOptions {
  readonly force?: boolean;
  readonly keepPolicies?: boolean;
  readonly json?: boolean;
}

export interface ProjectPromoteOptions {
  readonly json?: boolean;
  /** Override `~/.coodra` resolution — tests inject a tmp home. */
  readonly home?: string;
}

export interface ProjectDemoteOptions {
  readonly json?: boolean;
  /** Override `~/.coodra` resolution — tests inject a tmp home. */
  readonly home?: string;
}

export interface ProjectIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
}

export const DEFAULT_PROJECT_IO: ProjectIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export async function runProjectListCommand(options: ProjectListOptions, ioOverride?: ProjectIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  const handle = await openHandle(io);
  try {
    const all = await listProjects(handle);
    const filtered = options.includeGlobal === true ? all : all.filter((p) => p.id !== GLOBAL_PROJECT_ID);
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, projects: filtered.map(serializeListRow) }, null, 2)}\n`);
    } else {
      io.writeStdout(`${commandTitle('Projects', `${filtered.length} registered`, { width: terminalWidth() })}\n`);
      if (filtered.length === 0) {
        io.writeStdout(
          `${pc.dim('—')} no projects in this coodra store. Run \`coodra init\` in a project root to register one.\n`,
        );
      } else {
        for (const p of filtered) {
          printListRowHuman(io, p);
        }
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

export async function runProjectShowCommand(
  identifier: string,
  options: ProjectShowOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'project show requires <identifier> (slug or id)');
  }
  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier.trim());
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, project: serializeDetailRow(project) }, null, 2)}\n`);
    } else {
      printDetailRowHuman(io, project);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

export async function runProjectResetCommand(
  identifier: string,
  options: ProjectResetOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  if (identifier.trim().length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'project reset requires <identifier> (slug or id)');
  }
  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier.trim());
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (project.id === GLOBAL_PROJECT_ID) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `cannot reset the '${GLOBAL_PROJECT_ID}' sentinel — losing it breaks the audit-fallback path for unregistered cwds (F7)`,
      );
    }
    if (options.force !== true) {
      const planned = `${project.runCount} run(s) + their events / decisions / policy_decisions / context_packs`;
      const policyNote =
        options.keepPolicies === false
          ? ' AND their policies + policy_rules + project-scoped kill_switches'
          : ' (policies preserved)';
      return surfaceError(
        io,
        json,
        EXIT_USER_ACTION_REQUIRED,
        `project reset will delete ${planned}${policyNote}. Re-run with --force to confirm.`,
      );
    }
    const result = await resetProject(handle, project.id, {
      keepPolicies: options.keepPolicies !== false,
    });
    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    } else {
      io.writeStdout(`${pc.green('✓')} Reset project "${project.slug}" (${project.id}):\n`);
      io.writeStdout(`  runs:             ${result.runsDeleted}\n`);
      io.writeStdout(`  run_events:       ${result.runEventsDeleted}\n`);
      io.writeStdout(`  policy_decisions: ${result.policyDecisionsDeleted}\n`);
      io.writeStdout(`  decisions:        ${result.decisionsDeleted}\n`);
      io.writeStdout(`  context_packs:    ${result.contextPacksDeleted}\n`);
      if (options.keepPolicies === false) {
        io.writeStdout(`  kill_switches:    ${result.killSwitchesDeleted}\n`);
        io.writeStdout(`  policies:         ${result.policiesDeleted}\n`);
        io.writeStdout(`  policy_rules:     ${result.policyRulesDeleted}\n`);
      } else {
        io.writeStdout(`  policies:         ${pc.dim('preserved (use --keep-policies=false to drop)')}\n`);
      }
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

/**
 * `coodra project promote [identifier]` — W5 / beta.5 (2026-05-13).
 *
 * Promotes a project from the solo-mode `__solo__` sentinel org to the
 * caller's verified Clerk org. This is the explicit counterpart to the
 * implicit promote that `coodra init` now does — for the common case
 * where someone ran `coodra init` (solo) BEFORE `coodra team init`
 * + `coodra login`, leaving the project stuck local-only: it renders
 * in the web + local SQLite but never reaches cloud Postgres, and every
 * `feature add` reports "team-mode sync skipped — local-only project org".
 *
 * Resolves the target project from `[identifier]` (slug or id) if given,
 * else from `<cwd>/.coodra.json::projectSlug`. Calls `ensureProject`
 * with the verified org id — the promote branch updates the row AND
 * enqueues sync_to_cloud for the project + every pre-existing feature.
 *
 * Refuses in solo mode (nothing to promote to) and when there's no
 * verified Clerk session (run `coodra login` first).
 */
export async function runProjectPromoteCommand(
  identifierArg: string | undefined,
  options: ProjectPromoteOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  const homePath = options.home ?? io.coodraHome ?? resolveCoodraHome();

  // Solo mode → nothing to promote to.
  const teamCfg = readTeamConfig({ homeOverride: homePath });
  if (teamCfg.mode !== 'team') {
    return surfaceError(
      io,
      json,
      EXIT_USER_ACTION_REQUIRED,
      'this machine is in solo mode — there is no team org to promote into. Run `coodra team init` + `coodra login` first.',
    );
  }

  // Verified Clerk JWT is the source of truth for the org id (Phase G).
  const verified = await readVerifiedToken({ homeOverride: homePath });
  if (verified === null) {
    return surfaceError(
      io,
      json,
      EXIT_USER_ACTION_REQUIRED,
      'no verified Clerk session (or it expired). Run `coodra login` first, then re-run `coodra project promote`.',
    );
  }
  const targetOrgId = verified.orgId;
  if (typeof targetOrgId !== 'string' || targetOrgId.length === 0) {
    return surfaceError(io, json, EXIT_USER_RECOVERABLE, 'verified Clerk session has no org id — cannot promote.');
  }

  // Resolve which project to promote.
  let identifier = identifierArg?.trim();
  if (identifier === undefined || identifier.length === 0) {
    // Fall back to <cwd>/.coodra.json::projectSlug.
    const cfgPath = `${process.cwd()}/.coodra.json`;
    try {
      const { readFileSync } = await import('node:fs');
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { projectSlug?: string };
      if (typeof parsed.projectSlug === 'string' && parsed.projectSlug.length > 0) {
        identifier = parsed.projectSlug;
      }
    } catch {
      // no .coodra.json in cwd
    }
    if (identifier === undefined || identifier.length === 0) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        'no [identifier] given and no .coodra.json in the current directory. ' +
          'Run from a project root, or pass the slug/id explicitly: `coodra project promote <slug>`.',
      );
    }
  }

  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier);
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (project.id === GLOBAL_PROJECT_ID) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `cannot promote the '${GLOBAL_PROJECT_ID}' sentinel`);
    }
    if (project.orgId !== SOLO_ORG_ID && project.orgId !== '__global__') {
      // Already a real org. If it matches, no-op; if it differs, refuse.
      if (project.orgId === targetOrgId) {
        if (json) {
          io.writeStdout(`${JSON.stringify({ ok: true, alreadyPromoted: true, orgId: targetOrgId }, null, 2)}\n`);
        } else {
          io.writeStdout(
            `${pc.gray('·')} Project "${project.slug}" already belongs to org ${targetOrgId} — nothing to do.\n`,
          );
        }
        return io.exit(EXIT_OK);
      }
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `project "${project.slug}" already belongs to org "${project.orgId}", not your verified org "${targetOrgId}". ` +
          'Refusing to silently move a project between Clerk orgs.',
      );
    }

    // ensureProject's promote branch: updates org_id + enqueues sync.
    // COODRA_MODE must be 'team' for the enqueue branch to fire.
    process.env.COODRA_MODE = 'team';
    let result: Awaited<ReturnType<typeof ensureProject>>;
    try {
      result = await ensureProject(handle, { slug: project.slug, orgId: targetOrgId });
    } catch (err) {
      if (err instanceof EnsureProjectError) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `${err.message} ${err.howToFix}`);
      }
      throw err;
    }

    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, ...result, orgId: targetOrgId }, null, 2)}\n`);
    } else if (result.orgPromoted === true) {
      io.writeStdout(
        `${pc.green('✓')} Promoted project "${project.slug}" to org ${pc.cyan(targetOrgId)} ` +
          `(was ${result.promotedFromOrgId ?? SOLO_ORG_ID}).\n` +
          `  The project + its existing features are queued for cloud sync — ` +
          `they'll reach Postgres within ~10s. Run \`coodra doctor --full\` to watch the sync queue drain.\n`,
      );
    } else {
      io.writeStdout(`${pc.gray('·')} Project "${project.slug}" — no org change applied.\n`);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

/**
 * `coodra project demote [identifier]` — W6 / beta.6 (2026-05-14).
 *
 * The SAFE inverse of `project promote`: flips a project from a real
 * Clerk org back to the solo (`__solo__`) sentinel so it stops syncing.
 *
 * Why this is gated and not a free operation — `promote` (solo→team) is
 * additive and always safe, but `demote` (team→solo) is subtractive and
 * the subtraction often *can't actually happen*:
 *
 *   - Once a project synced, cloud Postgres holds its `projects` row
 *     (+ child runs/features/decisions). Flipping only the LOCAL org_id
 *     to `__solo__` leaves cloud saying `<team org>` — a split-brain the
 *     team-rows-puller would fight every 10s, and the beta.5
 *     `org_mismatch` guard exists precisely to prevent.
 *   - The data is already shared: every row pushed while team-tagged is
 *     still in the team's Supabase, visible to all members. Demote can't
 *     claw that back.
 *
 * So `demote` only succeeds in the narrow window where NOTHING has left
 * the machine yet — exactly the "init went team by mistake, I noticed
 * immediately" case. The gate: query cloud Postgres for a `projects`
 * row with this id.
 *
 *   - Row present in cloud  → REFUSE (already synced; split-brain risk).
 *   - Cloud unreachable      → REFUSE (can't verify — re-run connected).
 *   - Row absent in cloud    → SAFE: flip local org_id → __solo__ and
 *                              drop the project's pending sync jobs.
 *
 * Truly removing an already-synced project from a team is a
 * high-blast-radius admin operation (deletes team data, affects every
 * member) — deliberately NOT this command.
 */
export async function runProjectDemoteCommand(
  identifierArg: string | undefined,
  options: ProjectDemoteOptions,
  ioOverride?: ProjectIO,
): Promise<void> {
  const io = ioOverride ?? DEFAULT_PROJECT_IO;
  const json = options.json === true;
  const homePath = options.home ?? io.coodraHome ?? resolveCoodraHome();

  const teamCfg = readTeamConfig({ homeOverride: homePath });
  if (teamCfg.mode !== 'team') {
    return surfaceError(
      io,
      json,
      EXIT_USER_ACTION_REQUIRED,
      'this machine is in solo mode — every project is already solo. Nothing to demote.',
    );
  }

  // Resolve which project to demote (arg, else <cwd>/.coodra.json).
  let identifier = identifierArg?.trim();
  if (identifier === undefined || identifier.length === 0) {
    const cfgPath = `${process.cwd()}/.coodra.json`;
    try {
      const { readFileSync } = await import('node:fs');
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { projectSlug?: string };
      if (typeof parsed.projectSlug === 'string' && parsed.projectSlug.length > 0) {
        identifier = parsed.projectSlug;
      }
    } catch {
      // no .coodra.json in cwd
    }
    if (identifier === undefined || identifier.length === 0) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        'no [identifier] given and no .coodra.json in the current directory. ' +
          'Run from a project root, or pass the slug/id explicitly: `coodra project demote <slug>`.',
      );
    }
  }

  const handle = await openHandle(io);
  try {
    const project = await getProjectByIdentifier(handle, identifier);
    if (project === null) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `no project with slug or id "${identifier}"`);
    }
    if (project.id === GLOBAL_PROJECT_ID) {
      return surfaceError(io, json, EXIT_USER_RECOVERABLE, `cannot demote the '${GLOBAL_PROJECT_ID}' sentinel`);
    }
    if (project.orgId === SOLO_ORG_ID || project.orgId === GLOBAL_ORG_ID) {
      if (json) {
        io.writeStdout(`${JSON.stringify({ ok: true, alreadySolo: true }, null, 2)}\n`);
      } else {
        io.writeStdout(
          `${pc.gray('·')} Project "${project.slug}" is already solo (${project.orgId}) — nothing to do.\n`,
        );
      }
      return io.exit(EXIT_OK);
    }

    // SAFETY GATE — has this project ever reached cloud Postgres?
    const envBlock = readTeamHomeEnv({ homeOverride: homePath });
    if (envBlock === null) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        '~/.coodra/.env is missing DATABASE_URL — cannot verify cloud sync state. Re-run `coodra team init` to repair.',
      );
    }
    let cloudHasRow: boolean;
    try {
      const cloud = createPostgresDb({ databaseUrl: envBlock.databaseUrl });
      try {
        const found = await cloud.db
          .select({ id: postgresSchema.projects.id })
          .from(postgresSchema.projects)
          .where(eq(postgresSchema.projects.id, project.id))
          .limit(1);
        cloudHasRow = found[0] !== undefined;
      } finally {
        await cloud.close();
      }
    } catch (err) {
      // Cloud unreachable → REFUSE. Demoting without verifying could
      // create the split-brain this command exists to avoid.
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `cannot reach cloud Postgres to verify sync state (${err instanceof Error ? err.message : String(err)}). ` +
          'Re-run `coodra project demote` when connected — demote refuses to guess.',
      );
    }

    if (cloudHasRow) {
      return surfaceError(
        io,
        json,
        EXIT_USER_RECOVERABLE,
        `project "${project.slug}" has already synced to the team org — its row (and any runs/features/decisions ` +
          'that reference it) exist in cloud Postgres and are visible to every member. Demoting only the local ' +
          'copy would split-brain it. To work privately, run `coodra init --solo` in a fresh project directory. ' +
          'To remove this project from the team entirely, that is an admin delete-from-cloud operation — not this command.',
      );
    }

    // SAFE PATH — nothing left the machine. Flip org_id → __solo__ and
    // drop the project's pending sync_to_cloud jobs so the demote isn't
    // immediately undone by a queued push.
    handle.raw
      .prepare('UPDATE projects SET org_id = ?, updated_at = ? WHERE id = ?')
      .run(SOLO_ORG_ID, Math.floor(Date.now() / 1000), project.id);
    const deleted = handle.raw
      .prepare(`DELETE FROM pending_jobs WHERE queue = 'sync_to_cloud' AND payload LIKE ?`)
      .run(`%${project.id}%`);
    const jobsDropped = (deleted.changes as number) ?? 0;

    if (json) {
      io.writeStdout(
        `${JSON.stringify({ ok: true, demoted: true, fromOrgId: project.orgId, jobsDropped }, null, 2)}\n`,
      );
    } else {
      io.writeStdout(
        `${pc.green('✓')} Demoted project "${project.slug}" to solo (was ${project.orgId}).\n` +
          `  It had not yet synced — no cloud rows existed, so this is a clean local-only revert.\n` +
          (jobsDropped > 0
            ? `  Dropped ${jobsDropped} pending sync job${jobsDropped === 1 ? '' : 's'} for this project.\n`
            : ''),
      );
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

async function openHandle(io: ProjectIO): Promise<Awaited<ReturnType<typeof openLocalDb>>> {
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const dbPath = resolveCoodraDataDb(homePath);
  return await openLocalDb(dbPath);
}

interface SerializedListRow {
  readonly id: string;
  readonly slug: string;
  readonly orgId: string;
  readonly name: string;
  readonly cwd: string | null;
  readonly createdAt: string;
  readonly runCount: number;
  readonly lastRunAt: string | null;
  readonly isGlobal: boolean;
}

interface SerializedDetailRow extends SerializedListRow {
  readonly recentRuns: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly agentType: string;
    readonly status: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
  }>;
  readonly statusCounts: Readonly<Record<string, number>>;
}

function serializeListRow(p: ProjectListRow): SerializedListRow {
  return {
    id: p.id,
    slug: p.slug,
    orgId: p.orgId,
    name: p.name,
    cwd: p.cwd,
    createdAt: p.createdAt.toISOString(),
    runCount: p.runCount,
    lastRunAt: p.lastRunAt?.toISOString() ?? null,
    isGlobal: p.id === GLOBAL_PROJECT_ID,
  };
}

function serializeDetailRow(p: ProjectDetailRow): SerializedDetailRow {
  return {
    ...serializeListRow(p),
    recentRuns: p.recentRuns.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      agentType: r.agentType,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    })),
    statusCounts: p.statusCounts,
  };
}

function printListRowHuman(io: ProjectIO, p: ProjectListRow): void {
  const tag = p.id === GLOBAL_PROJECT_ID ? pc.dim(' (sentinel)') : '';
  const last = p.lastRunAt === null ? 'never' : p.lastRunAt.toISOString();
  io.writeStdout(`${pc.bold(p.slug)}${tag} — id: ${p.id}\n`);
  io.writeStdout(`  name: ${p.name}\n`);
  io.writeStdout(`  org: ${p.orgId}\n`);
  io.writeStdout(`  cwd: ${p.cwd ?? pc.dim('(unset)')}\n`);
  io.writeStdout(`  runs: ${p.runCount} (last: ${last})\n`);
  io.writeStdout(`  created: ${p.createdAt.toISOString()}\n\n`);
}

function printDetailRowHuman(io: ProjectIO, p: ProjectDetailRow): void {
  printListRowHuman(io, p);
  if (Object.keys(p.statusCounts).length > 0) {
    io.writeStdout('  status breakdown:\n');
    for (const [status, n] of Object.entries(p.statusCounts).sort()) {
      io.writeStdout(`    ${status.padEnd(12, ' ')} ${n}\n`);
    }
  }
  if (p.recentRuns.length > 0) {
    io.writeStdout(`  recent runs (showing ${p.recentRuns.length}):\n`);
    for (const r of p.recentRuns) {
      io.writeStdout(`    ${r.id} (${r.agentType}, ${r.status}, started ${r.startedAt.toISOString()})\n`);
    }
  }
}

function surfaceError(io: ProjectIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(exitCode);
}

void ({} as ResetProjectResult);
