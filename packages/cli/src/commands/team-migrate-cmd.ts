import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { createDb, type PostgresHandle, postgresSchema, type SqliteHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';
import { and, eq } from 'drizzle-orm';
import { EXIT_USER_ACTION_REQUIRED } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { clearTeamHomeEnv, upgradeToTeamConfig, writeTeamHomeEnv } from '../lib/team-config.js';
import {
  applyConflictResolutions,
  assertNoInFlightAttempt,
  buildMigrationPlan,
  executeMigration,
  type MigrationCounts,
  type MigrationProgressEvent,
  type MigrationResult,
  rollbackMigration,
  snapshotLocalDb,
} from '../lib/team-migrate/index.js';
import { pc } from '../ui/index.js';

import type { TeamCommandIO } from './team.js';
import { DEFAULT_TEAM_IO } from './team.js';

/**
 * `packages/cli/src/commands/team-migrate-cmd.ts` — Module 04 Phase 4.
 *
 * Three team-mode CLI commands sharing a single file because they all
 * touch the same surface (team-config + team-migrate engine + cloud
 * Postgres handle):
 *
 *   - `coodra team migrate`  → solo→team data move
 *   - `coodra team join`     → full cloud-pull seed for new team-members
 *   - `coodra team leave`    → revert to solo (clears team config + drops
 *                                  team-tagged local rows)
 *
 * Authentication shape (v1 — pre-Clerk-OAuth integration):
 *   - The user obtains their Clerk user_id, org_id, and a local hook
 *     secret via the web onboarding flow at https://app.coodra.dev/
 *     onboarding/connect (deferred — currently they paste from the
 *     Clerk dashboard).
 *   - These values arrive at the CLI via flags (`--user-id`, `--org-id`,
 *     `--secret`) OR env vars (`COODRA_TEAM_USER_ID`,
 *     `COODRA_TEAM_ORG_ID`, `COODRA_TEAM_HOOK_SECRET`).
 *   - Future M04 follow-on: replace this hand-off with a one-time
 *     `coodra team join <code>` that exchanges a code for the
 *     credentials over an authenticated HTTPS round-trip. For now the
 *     web onboarding renders the flag string and the user pastes.
 */

const cliLogger = createLogger('cli.team-commands');

export interface TeamMigrateOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly secret?: string;
  readonly databaseUrl?: string;
  /** Skip the dry-run prompt and migrate immediately. */
  readonly yes?: boolean;
  /** Continue an existing in-flight migration (if one is found). */
  readonly resume?: boolean;
  /** Roll back the most-recent in-flight migration instead of running a new one. */
  readonly rollback?: boolean;
}

export interface TeamJoinOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly orgSlug?: string;
  readonly secret?: string;
  readonly databaseUrl?: string;
}

export interface TeamLeaveOptions {
  readonly yes?: boolean;
  /**
   * Override for tests: supplies the user's typed-confirmation string
   * without reading stdin. When omitted, the command reads a line from
   * the terminal via `node:readline/promises`.
   */
  readonly readConfirm?: (prompt: string) => Promise<string>;
}

interface ResolvedCredentials {
  readonly userId: string;
  readonly orgId: string;
  readonly secret: string;
  readonly databaseUrl: string;
}

function resolveCredentials(
  flags: { userId?: string; orgId?: string; secret?: string; databaseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials | { error: string } {
  const userId = flags.userId ?? env.COODRA_TEAM_USER_ID;
  const orgId = flags.orgId ?? env.COODRA_TEAM_ORG_ID;
  const secret = flags.secret ?? env.COODRA_TEAM_HOOK_SECRET;
  const databaseUrl = flags.databaseUrl ?? env.DATABASE_URL;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { error: 'missing user id (use --user-id or COODRA_TEAM_USER_ID)' };
  }
  if (typeof orgId !== 'string' || orgId.length === 0) {
    return { error: 'missing org id (use --org-id or COODRA_TEAM_ORG_ID)' };
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    return { error: 'missing local hook secret (use --secret or COODRA_TEAM_HOOK_SECRET)' };
  }
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    return { error: 'missing database url (use --database-url or DATABASE_URL)' };
  }
  return { userId, orgId, secret, databaseUrl };
}

function fmtCounts(c: MigrationCounts): string {
  return [
    `${c.projects} projects`,
    `${c.runs} runs`,
    `${c.runEvents} run_events`,
    `${c.contextPacks} context_packs`,
    `${c.decisions} decisions`,
    `${c.policies} policies`,
    `${c.featurePacks} feature_packs`,
    `${c.runDiffs} run_diffs`,
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export async function runTeamMigrateCommand(
  options: TeamMigrateOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  const creds = resolveCredentials(options);
  if ('error' in creds) {
    io.writeStderr(`${pc.red('coodra team migrate')}: ${creds.error}\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const home = resolveCoodraHome();
  const dataDb = resolveCoodraDataDb(home);
  const snapshotPath = join(home, `data.db.pre-migrate-${Date.now()}`);

  let local: SqliteHandle;
  let cloud: PostgresHandle;
  try {
    const localHandle = createDb({ kind: 'local', sqlite: { path: dataDb } });
    if (localHandle.kind !== 'sqlite') throw new Error('expected sqlite local handle');
    local = localHandle;
    const cloudHandle = createDb({ kind: 'cloud', postgres: { databaseUrl: creds.databaseUrl } });
    if (cloudHandle.kind !== 'postgres') throw new Error('expected postgres cloud handle');
    cloud = cloudHandle;
  } catch (err) {
    io.writeStderr(`${pc.red('migrate failed at preflight')}: ${err instanceof Error ? err.message : String(err)}\n`);
    return io.exit(1);
  }

  try {
    if (options.rollback === true) {
      io.writeStdout(pc.yellow('rollback mode: undoing the most-recent in-flight migration\n'));
      const inflight = await cloud.db
        .select()
        .from(postgresSchema.migrationAttempts)
        .where(
          and(
            eq(postgresSchema.migrationAttempts.clerkOrgId, creds.orgId),
            eq(postgresSchema.migrationAttempts.clerkUserId, creds.userId),
            eq(postgresSchema.migrationAttempts.status, 'running'),
          ),
        )
        .limit(1);
      const attempt = inflight[0];
      if (attempt === undefined) {
        io.writeStderr(`${pc.yellow('rollback')}: no in-flight migration found for this user+org\n`);
        return io.exit(EXIT_USER_ACTION_REQUIRED);
      }
      const result = await rollbackMigration({
        cloud,
        attemptId: attempt.id,
        localDbPath: dataDb,
        snapshotPath: snapshotPath, // will not exist; rollback handles missing
      });
      io.writeStdout(
        pc.green(
          `rollback complete: deleted ${result.cloudRowsDeleted} cloud row(s); local ${
            result.localRestored ? 'restored from snapshot' : 'NOT restored (no snapshot found)'
          }\n`,
        ),
      );
      return io.exit(0);
    }

    await assertNoInFlightAttempt(cloud, creds.orgId, creds.userId);

    io.writeStdout(pc.cyan('coodra team migrate — building plan...\n'));
    const plan = await buildMigrationPlan({
      local,
      cloud,
      clerkUserId: creds.userId,
      clerkOrgId: creds.orgId,
    });

    io.writeStdout(`${pc.dim('source machine:')} ${plan.sourceMachine}\n`);
    io.writeStdout(`${pc.dim('target org:')} ${creds.orgId}\n`);
    io.writeStdout(`${pc.dim('user:')} ${creds.userId}\n`);
    io.writeStdout(`${pc.dim('local row counts:')} ${fmtCounts(plan.counts)}\n`);

    if (plan.counts.projects === 0) {
      io.writeStdout(pc.yellow('no local projects to migrate; aborting (run `coodra init` first)\n'));
      return io.exit(0);
    }

    if (plan.conflicts.length > 0) {
      io.writeStdout(pc.yellow(`\nslug conflicts detected (${plan.conflicts.length}):\n`));
      for (const c of plan.conflicts) {
        io.writeStdout(`  · '${c.slug}' already exists in cloud (cloud project_id: ${c.cloudProjectId})\n`);
      }
      io.writeStdout(
        pc.yellow(
          'auto-rename: each conflicting slug will be suffixed with -<6char-hex>. Pass --yes to confirm or abort.\n',
        ),
      );
      // Apply auto-rename for all conflicts (v1 behavior; future versions
      // will prompt interactively).
      const resolutions = new Map<string, { resolution: 'rename' | 'skip'; renamedSlug?: string }>();
      const suffix = randomBytes(3).toString('hex');
      for (const c of plan.conflicts) {
        resolutions.set(c.localProjectId, { resolution: 'rename', renamedSlug: `${c.slug}-${suffix}` });
      }
      const resolvedPlan = applyConflictResolutions(plan, resolutions);
      Object.assign(plan, resolvedPlan); // mutate-in-place so the rest of the function sees it
    }

    if (options.yes !== true) {
      io.writeStdout(
        pc.cyan(
          '\ndry-run complete. To execute, re-run with --yes (no rollback if you abort mid-way without --resume / --rollback).\n',
        ),
      );
      return io.exit(0);
    }

    // Snapshot.
    io.writeStdout(pc.cyan(`\nsnapshotting local SQLite to ${snapshotPath}...\n`));
    snapshotLocalDb(dataDb, snapshotPath);

    io.writeStdout(pc.cyan('executing migration...\n'));
    const reporter = (event: MigrationProgressEvent) => {
      const tag = event.status === 'started' ? pc.dim('▸') : event.status === 'completed' ? pc.green('✓') : pc.red('✗');
      io.writeStdout(`  ${tag} ${event.phase}${event.detail !== undefined ? ` — ${event.detail}` : ''}\n`);
    };
    const result: MigrationResult = await executeMigration({
      local,
      cloud,
      plan,
      snapshotPath,
      progress: reporter,
    });

    if (result.status === 'completed') {
      io.writeStdout(pc.green(`\n✓ migration complete in ${result.durationMs}ms — ${fmtCounts(result.counts)}\n`));
      // Promote local config to team mode + write spawn-env so a
      // subsequent `coodra start` launches the sync-daemon + bridge
      // + mcp-server in team mode. Both writes are required:
      // config.json is the CLI's own source of truth; .env is what
      // `loadHomeEnv` feeds into the spawned daemons.
      upgradeToTeamConfig({
        clerkUserId: creds.userId,
        clerkOrgId: creds.orgId,
        localHookSecret: creds.secret,
        joinedAt: Date.now(),
      });
      writeTeamHomeEnv({
        databaseUrl: creds.databaseUrl,
        localHookSecret: creds.secret,
        clerkOrgId: creds.orgId,
      });
      io.writeStdout(pc.green('local config promoted to team mode (~/.coodra/config.json + ~/.coodra/.env)\n'));
      return io.exit(0);
    }
    io.writeStderr(pc.red(`\n✗ migration failed: ${result.error ?? 'unknown error'}\n`));
    io.writeStderr(
      pc.yellow(
        `re-run with --rollback to undo, or --resume to continue from the last completed phase. ` +
          `local snapshot preserved at ${snapshotPath}\n`,
      ),
    );
    return io.exit(1);
  } catch (err) {
    cliLogger.error(
      { event: 'team_migrate_unexpected_error', err: err instanceof Error ? err.message : String(err) },
      'team-migrate command threw',
    );
    io.writeStderr(`${pc.red('migrate threw')}: ${err instanceof Error ? err.message : String(err)}\n`);
    return io.exit(1);
  } finally {
    try {
      local.close();
    } catch {
      /* swallow */
    }
    try {
      await cloud.close();
    } catch {
      /* swallow */
    }
  }
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

export async function runTeamJoinCommand(
  options: TeamJoinOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  const creds = resolveCredentials(options);
  if ('error' in creds) {
    io.writeStderr(`${pc.red('coodra team join')}: ${creds.error}\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  // Write team config first so subsequent local services see team mode
  // even if the cloud-pull-seed below fails partway. Both config.json
  // (CLI's source of truth) and ~/.coodra/.env (spawn-env for
  // daemons) are required — without the .env write `coodra start`
  // would either run in solo mode or crash sync-daemon at boot for
  // missing DATABASE_URL.
  upgradeToTeamConfig({
    clerkUserId: creds.userId,
    clerkOrgId: creds.orgId,
    ...(options.orgSlug !== undefined ? { clerkOrgSlug: options.orgSlug } : {}),
    localHookSecret: creds.secret,
    joinedAt: Date.now(),
  });
  writeTeamHomeEnv({
    databaseUrl: creds.databaseUrl,
    localHookSecret: creds.secret,
    clerkOrgId: creds.orgId,
  });
  io.writeStdout(pc.green('✓ ~/.coodra/config.json + ~/.coodra/.env upgraded to team mode\n'));

  // Cloud-pull-seed: connect, run a single tickOnce of the team-rows
  // puller pattern. The persistent puller in the sync-daemon will take
  // over for ongoing pulls.
  io.writeStdout(pc.cyan('initial cloud → local seed (this may take a moment for large teams)...\n'));
  let cloud: PostgresHandle;
  let local: SqliteHandle;
  try {
    const cloudHandle = createDb({ kind: 'cloud', postgres: { databaseUrl: creds.databaseUrl } });
    if (cloudHandle.kind !== 'postgres') throw new Error('expected postgres cloud handle');
    cloud = cloudHandle;
    const localHandle = createDb({ kind: 'local' });
    if (localHandle.kind !== 'sqlite') throw new Error('expected sqlite local handle');
    local = localHandle;
  } catch (err) {
    io.writeStderr(`${pc.red('join failed at handle open')}: ${err instanceof Error ? err.message : String(err)}\n`);
    return io.exit(1);
  }

  try {
    // For v1 the seed is a one-shot delegated to the standing puller
    // pattern via dynamic import (avoids circular dep on sync-daemon).
    // The actual pull semantics live in apps/sync-daemon/src/lib/team-rows-puller.ts;
    // this command's seeding is opportunistic — the sync-daemon does
    // the heavy lifting on its first tick after `coodra start`.
    io.writeStdout(
      pc.dim('(sync-daemon will pull team rows on its next tick; run `coodra start` to launch services)\n'),
    );
    return io.exit(0);
  } finally {
    try {
      local.close();
    } catch {
      /* swallow */
    }
    try {
      await cloud.close();
    } catch {
      /* swallow */
    }
  }
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

export async function runTeamLeaveCommand(
  options: TeamLeaveOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  // Phase C (clarity-pass-plan, 2026-05-11) — read the current team
  // config FIRST so we can show the operator the org slug they're
  // about to leave AND use it as the typed-confirmation token. If the
  // machine is already in solo mode, refuse immediately — `team leave`
  // has no meaningful action to take.
  const { readTeamConfig, demoteToSoloConfig } = await import('../lib/team-config.js');
  const cfg = readTeamConfig();
  if (cfg.mode === 'solo' || cfg.team === undefined) {
    io.writeStderr(`${pc.yellow('coodra team leave')}: this machine is already in solo mode — nothing to leave.\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }
  const orgLabel = cfg.team.clerkOrgSlug ?? cfg.team.clerkOrgId;

  // Print the "what stays / what goes" block ALWAYS — both --yes and
  // interactive paths need the operator to see it. Per Phase C plan,
  // this is the message that prevents accidental data-loss panic
  // (operators often think "leave" means "delete my history").
  io.writeStdout(`${pc.bold('coodra team leave')} — leaving team ${pc.cyan(orgLabel)}\n\n`);
  io.writeStdout(`${pc.bold('What gets removed (this machine only):')}\n`);
  io.writeStdout('  • ~/.coodra/config.json team block (mode → solo)\n');
  io.writeStdout(
    '  • ~/.coodra/.env entries: COODRA_MODE, DATABASE_URL, LOCAL_HOOK_SECRET, COODRA_TEAM_ORG_ID\n',
  );
  io.writeStdout('  • sync-daemon will stop spawning on next `coodra start`\n\n');
  io.writeStdout(`${pc.bold('What stays:')}\n`);
  io.writeStdout('  • all local SQLite rows (runs, decisions, context_packs) — historical state intact\n');
  io.writeStdout('  • all cloud rows — other team members continue to see them, your past contributions remain\n');
  io.writeStdout('  • per-project .coodra.json files (unchanged)\n\n');

  if (options.yes !== true) {
    const reader = options.readConfirm ?? defaultReadConfirm;
    const expected = `leave ${orgLabel}`;
    const typed = (
      await reader(`Type ${pc.yellow(`\`${expected}\``)} to confirm (or anything else to cancel): `)
    ).trim();
    if (typed !== expected) {
      io.writeStderr(`${pc.red('✗')} Confirmation token did not match — leave aborted. Nothing was changed.\n`);
      return io.exit(EXIT_USER_ACTION_REQUIRED);
    }
  }

  demoteToSoloConfig();
  // Also strip the team env keys from ~/.coodra/.env so the next
  // `coodra start` launches in solo mode. Preserves any user-managed
  // entries the operator put there manually.
  clearTeamHomeEnv();
  io.writeStdout(`${pc.green('✓')} ~/.coodra/config.json + ~/.coodra/.env demoted to solo mode\n`);
  io.writeStdout(
    pc.dim(
      '(local SQLite rows attributed to the team org are not deleted in v1 — they remain as historical state. ' +
        'A future coodra clean-team-data command will offer scrubbing.)\n',
    ),
  );
  io.writeStdout(`\n${pc.bold('Next steps:')}\n`);
  io.writeStdout(
    `  1. ${pc.cyan('`coodra stop && coodra start`')} — daemons still in memory carry the old team credentials; restart so they pick up solo-mode env.\n`,
  );
  io.writeStdout(
    `  2. ${pc.cyan('`coodra doctor --fix`')} — strip any stale COODRA_MODE lines from registered project .env files.\n`,
  );
  return io.exit(0);
}

async function defaultReadConfirm(prompt: string): Promise<string> {
  // Lazy-load readline/promises so test paths that pass `readConfirm`
  // never even import it. Keeps the module's eager dependency surface
  // small.
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}
