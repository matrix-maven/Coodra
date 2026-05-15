import { randomBytes } from 'node:crypto';

import { createPostgresDb, ensurePgVector, migratePostgres, type PostgresHandle } from '@coodra/db';
import { sql } from 'drizzle-orm';
import { EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { upgradeToTeamConfig, writeTeamHomeEnv } from '../lib/team-config.js';
import { pc } from '../ui/index.js';

import type { TeamCommandIO } from './team.js';
import { DEFAULT_TEAM_IO } from './team.js';

/**
 * `packages/cli/src/commands/team-setup-cmd.ts` — Module 04 Phase 4.
 *
 * `coodra team setup` — admin bootstrap for a brand-new team.
 *
 * The command an org admin runs ONCE per team after creating their own
 * Supabase (or any Postgres ≥16 with pgvector available) project. It:
 *
 *   1. Verifies the Postgres connection is reachable.
 *   2. Installs the pgvector extension (`CREATE EXTENSION IF NOT EXISTS
 *      vector` — requires superuser or the `pg_extension_role` Supabase
 *      assigns to the `postgres` role; new Supabase projects come with
 *      this granted by default).
 *   3. Applies all Drizzle migrations (idempotent).
 *   4. Generates a 32-byte local hook secret (or accepts one via
 *      `--secret` for re-runs / re-keying).
 *   5. Writes `~/.coodra/config.json::team` for the admin's own
 *      machine so their bridge + MCP server stamp `created_by_user_id`.
 *   6. Prints a "share with teammates" block with the four credentials
 *      they need for `coodra team join` (user_id, org_id, secret,
 *      database_url). The admin distributes this securely (Bitwarden,
 *      1Password, Slack DM with auto-deletion, etc.).
 *
 * "Bring your own Supabase" — Coodra does not host or proxy any
 * cloud DB on the team's behalf. Each team owns their data. The CLI's
 * only opinion is the schema (Drizzle migrations) and the connection
 * string format (a standard Postgres URL).
 *
 * Re-running `team setup` is safe — Drizzle's migration table dedupes,
 * `CREATE EXTENSION IF NOT EXISTS` is a no-op, the local config-write
 * is overwrite-the-existing-block. Use this to rotate the local hook
 * secret or to onboard a second admin to the same team.
 */

export interface TeamSetupOptions {
  readonly databaseUrl?: string;
  readonly userId?: string;
  readonly orgId?: string;
  readonly orgSlug?: string;
  readonly secret?: string;
  /** Skip the pgvector extension install (use when the Postgres role lacks CREATE EXTENSION). */
  readonly skipPgvector?: boolean;
  /** Print credentials in JSON instead of human-formatted prose. */
  readonly json?: boolean;
}

interface ResolvedSetupInput {
  readonly databaseUrl: string;
  readonly userId: string;
  readonly orgId: string;
  readonly orgSlug?: string;
  readonly secret: string;
}

function resolveSetupInput(
  options: TeamSetupOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetupInput | { error: string } {
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const userId = options.userId ?? env.COODRA_TEAM_USER_ID;
  const orgId = options.orgId ?? env.COODRA_TEAM_ORG_ID;
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
    return { error: 'missing database url (use --database-url or DATABASE_URL)' };
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    return { error: 'missing your Clerk user id (use --user-id or COODRA_TEAM_USER_ID)' };
  }
  if (typeof orgId !== 'string' || orgId.length === 0) {
    return { error: 'missing Clerk org id (use --org-id or COODRA_TEAM_ORG_ID)' };
  }
  const secret = options.secret ?? env.COODRA_TEAM_HOOK_SECRET ?? randomBytes(32).toString('hex');
  return {
    databaseUrl,
    userId,
    orgId,
    secret,
    ...(options.orgSlug !== undefined ? { orgSlug: options.orgSlug } : {}),
  };
}

function maskDatabaseUrl(url: string): string {
  // Replace the password component with *** for display.
  return url.replace(/:[^:@/]+@/, ':***@');
}

export async function runTeamSetupCommand(
  options: TeamSetupOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  const resolved = resolveSetupInput(options);
  if ('error' in resolved) {
    io.writeStderr(`${pc.red('coodra team setup')}: ${resolved.error}\n`);
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  io.writeStdout(
    pc.cyan(`coodra team setup — bootstrapping team Postgres at ${maskDatabaseUrl(resolved.databaseUrl)}\n`),
  );

  let cloud: PostgresHandle;
  try {
    cloud = createPostgresDb({ databaseUrl: resolved.databaseUrl });
  } catch (err) {
    io.writeStderr(
      `${pc.red('setup failed')}: cannot construct postgres client — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  try {
    // Step 1: connectivity check.
    io.writeStdout(pc.dim('  ▸ verifying connectivity (SELECT 1)...\n'));
    try {
      await cloud.raw`SELECT 1`;
    } catch (err) {
      io.writeStderr(
        `${pc.red('setup failed')}: SELECT 1 against the database threw — ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      io.writeStderr(
        pc.yellow(
          '  hint: check the DATABASE_URL credentials, that the Postgres host is reachable from this machine, and ' +
            'that no firewall is blocking outbound traffic to the database port.\n',
        ),
      );
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    io.writeStdout(pc.green('  ✓ connectivity ok\n'));

    // Step 2: pgvector extension.
    if (options.skipPgvector === true) {
      io.writeStdout(
        pc.yellow('  ▸ skipping pgvector install (--skip-pgvector). Vector queries will fail until installed.\n'),
      );
    } else {
      io.writeStdout(pc.dim('  ▸ installing pgvector extension (CREATE EXTENSION IF NOT EXISTS vector)...\n'));
      try {
        await ensurePgVector(cloud.db);
        io.writeStdout(pc.green('  ✓ pgvector ready\n'));
      } catch (err) {
        io.writeStderr(
          `${pc.red('setup failed')}: CREATE EXTENSION vector threw — ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        io.writeStderr(
          pc.yellow(
            '  hint: the Postgres role lacks CREATE EXTENSION privileges. On Supabase, ensure you are connecting as ' +
              'the `postgres` role from the connection-string panel. On self-hosted Postgres, run the extension install ' +
              'manually (`CREATE EXTENSION vector`) as a superuser, then re-run `team setup --skip-pgvector`.\n',
          ),
        );
        return io.exit(EXIT_USER_RECOVERABLE);
      }
    }

    // Step 3: schema migrations (idempotent).
    //
    // `migratePostgres` is a black box (drizzle-orm exposes no per-
    // migration callback), and on a remote Postgres target like Supabase
    // the 13-migration sequence can take 30-90s due to network round-
    // trips. Without a heartbeat the operator's terminal sits silent and
    // they wonder if the command is hung. The interval below ticks every
    // 5s with elapsed time so the user has visible feedback; cleared on
    // both success and failure paths.
    io.writeStdout(
      pc.dim('  ▸ applying schema migrations (Drizzle) — this can take 30-90s on remote Postgres targets...\n'),
    );
    const migrateStart = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - migrateStart) / 1000);
      io.writeStdout(pc.dim(`    … still applying (${elapsedSec}s elapsed)\n`));
    }, 5_000);
    try {
      await migratePostgres(cloud.db);
      clearInterval(heartbeat);
      const elapsedSec = Math.round((Date.now() - migrateStart) / 1000);
      io.writeStdout(pc.green(`  ✓ schema applied in ${elapsedSec}s\n`));
    } catch (err) {
      clearInterval(heartbeat);
      io.writeStderr(
        `${pc.red('setup failed')}: migration apply threw — ${err instanceof Error ? err.message : String(err)}\n`,
      );
      io.writeStderr(
        pc.yellow(
          '  hint: a previous partial migration may have left the schema in an in-between state. Inspect the ' +
            '`__drizzle_migrations` table in your Postgres for the last applied migration name and compare against ' +
            '`packages/db/drizzle/postgres/meta/_journal.json`.\n',
        ),
      );
      return io.exit(EXIT_USER_RECOVERABLE);
    }

    // Step 4: schema verification.
    io.writeStdout(pc.dim('  ▸ verifying schema (14 expected tables)...\n'));
    const tables = await cloud.raw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const present = new Set(tables.map((r) => r.table_name));
    const required = [
      'projects',
      'runs',
      'run_events',
      'context_packs',
      'pending_jobs',
      'policies',
      'policy_rules',
      'policy_decisions',
      'feature_packs',
      'decisions',
      'kill_switches',
      'run_diffs',
      '_migration_attempts',
      '_migration_map',
    ];
    const missing = required.filter((t) => !present.has(t));
    if (missing.length > 0) {
      io.writeStderr(
        `${pc.red('setup failed')}: post-migration schema check found ${missing.length} missing table(s): ` +
          `${missing.join(', ')}\n`,
      );
      return io.exit(EXIT_USER_RECOVERABLE);
    }
    io.writeStdout(pc.green(`  ✓ ${required.length} tables present\n`));

    // Step 5: write the local team config so this admin's own bridge + MCP
    // server start stamping created_by_user_id immediately.
    upgradeToTeamConfig({
      clerkUserId: resolved.userId,
      clerkOrgId: resolved.orgId,
      ...(resolved.orgSlug !== undefined ? { clerkOrgSlug: resolved.orgSlug } : {}),
      localHookSecret: resolved.secret,
      joinedAt: Date.now(),
    });
    io.writeStdout(pc.green('  ✓ local config promoted to team mode (~/.coodra/config.json)\n'));

    // Phase G — also write the env vars `coodra start` reads when
    // spawning the sync-daemon + bridge + mcp-server. Without this, the
    // daemons either crash at boot (sync-daemon: missing DATABASE_URL)
    // or run in solo mode (bridge / mcp-server: COODRA_MODE defaults
    // to solo). The team-config block in config.json is the CLI's own
    // source of truth; this .env write is the spawn-env source.
    writeTeamHomeEnv({
      databaseUrl: resolved.databaseUrl,
      localHookSecret: resolved.secret,
      clerkOrgId: resolved.orgId,
    });
    io.writeStdout(pc.green('  ✓ ~/.coodra/.env updated (COODRA_MODE=team, DATABASE_URL, LOCAL_HOOK_SECRET)\n'));

    // Step 6: print credentials block.
    if (options.json === true) {
      io.writeStdout(
        `${JSON.stringify(
          {
            ok: true,
            databaseUrl: resolved.databaseUrl,
            clerkUserId: resolved.userId,
            clerkOrgId: resolved.orgId,
            ...(resolved.orgSlug !== undefined ? { clerkOrgSlug: resolved.orgSlug } : {}),
            localHookSecret: resolved.secret,
            tablesPresent: required,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.writeStdout(pc.cyan('\n────────  share these credentials with your teammates  ────────\n'));
      io.writeStdout(
        `  ${pc.bold('database url')}        ${resolved.databaseUrl}\n` +
          `  ${pc.bold('clerk org id')}        ${resolved.orgId}\n` +
          `  ${pc.bold('local hook secret')}   ${resolved.secret}\n`,
      );
      io.writeStdout(pc.cyan('───────────────────────────────────────────────────────────────\n\n'));
      io.writeStdout(
        pc.dim(
          'Each teammate runs:\n' +
            `  ${pc.bold('coodra team join')} \\\n` +
            `    --user-id <their-clerk-user-id> \\\n` +
            `    --org-id ${resolved.orgId} \\\n` +
            `    --secret ${resolved.secret} \\\n` +
            `    --database-url '${resolved.databaseUrl}'\n\n`,
        ),
      );
      io.writeStdout(
        pc.dim(
          'Distribute the database url + secret via a secrets manager (Bitwarden / 1Password / Vault). ' +
            'They are sensitive — anyone with both can write to your team Postgres.\n',
        ),
      );
    }

    return io.exit(EXIT_OK);
  } finally {
    try {
      await cloud.close();
    } catch {
      /* swallow */
    }
  }
}

// Suppress unused import warning on `sql` — kept available for future
// schema-version probes inside the verify step.
void sql;
