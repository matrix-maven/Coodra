import { createPostgresDb, ensurePgVector, migratePostgres, type PostgresHandle } from '@coodra/db';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { pc } from '../ui/index.js';

/**
 * `coodra cloud-migrate` — apply Drizzle Postgres migrations to the
 * cloud database identified by `DATABASE_URL`.
 *
 * Used by self-hosters during initial deploy and on every deploy that
 * ships a new migration. Lives outside `apps/sync-daemon` so the operator
 * has an explicit migration step decoupled from daemon boot — this avoids
 * the race when N web instances or N sync-daemon instances start in
 * parallel against a fresh cloud DB.
 *
 * Idempotent: Drizzle's `__drizzle_migrations` table dedupes already-applied
 * migrations. Safe to re-run.
 *
 * Pre-flight safety (per OQ4 sign-off 2026-04-28). Before applying any
 * migration, we list every BASE TABLE in the `public` schema and compare
 * against the canonical schema set. If any table is unknown AND contains
 * rows, the command refuses to run with `EXIT_ENVIRONMENT_PROBLEM`. This
 * catches the migrate-skip footgun where the operator points
 * `DATABASE_URL` at the wrong database (a different application's DB, a
 * stale schema from a removed module, etc.). Empty unknown tables are
 * tolerated — they are most often artefacts of a previous migration that
 * no longer applies.
 */

export interface CloudMigrateOptions {
  /** Override `DATABASE_URL` from env. Tests pass this directly. */
  readonly databaseUrl?: string;
  /** Run pre-flight only; do not apply migrations. */
  readonly dryRun?: boolean;
  /** Emit JSON report instead of human-readable lines. */
  readonly json?: boolean;
}

export interface CloudMigrateIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_CLOUD_MIGRATE_IO: CloudMigrateIO = {
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

/**
 * Application tables shipped by `packages/db/src/schema/postgres.ts` (and
 * the postgres-only migration-tracking pair from M04 Phase 4).
 *
 * Updated 2026-05-09 (M04 Phase 4) — added kill_switches (M08b), run_diffs
 * (M06), and the migration-tracking pair (_migration_attempts +
 * _migration_map). `__drizzle_migrations` lives in the `drizzle` schema by
 * default but some deploys force it into `public` — we accept either to
 * avoid false-flag refusals on a previously-migrated DB.
 */
const EXPECTED_PUBLIC_TABLES: ReadonlySet<string> = new Set([
  '__drizzle_migrations',
  '_migration_attempts',
  '_migration_map',
  'context_packs',
  'decisions',
  'feature_packs',
  'kill_switches',
  'pending_jobs',
  'policies',
  'policy_decisions',
  'policy_rules',
  'projects',
  'run_diffs',
  'run_events',
  'runs',
]);

interface UnknownTableFinding {
  readonly name: string;
  readonly rowCount: bigint;
}

interface CloudMigrateReport {
  readonly databaseUrlMasked: string;
  readonly preflight: {
    readonly knownTables: ReadonlyArray<string>;
    readonly unknownEmptyTables: ReadonlyArray<string>;
    readonly unknownTablesWithRows: ReadonlyArray<UnknownTableFinding>;
  };
  readonly migrationsApplied: boolean;
  readonly dryRun: boolean;
}

export async function runCloudMigrateCommand(
  options: CloudMigrateOptions = {},
  io: CloudMigrateIO = DEFAULT_CLOUD_MIGRATE_IO,
): Promise<never> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    io.writeStderr(
      `${pc.red('coodra cloud-migrate')}: DATABASE_URL is required (pass --database-url or set the env var).\n`,
    );
    return io.exit(EXIT_USER_ACTION_REQUIRED);
  }

  const masked = maskDatabaseUrl(databaseUrl);
  let handle: PostgresHandle;
  try {
    handle = createPostgresDb({ databaseUrl });
  } catch (cause) {
    io.writeStderr(
      `${pc.red('coodra cloud-migrate')}: failed to construct Postgres client: ${errorMessage(cause)}\n`,
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const report: { -readonly [K in keyof CloudMigrateReport]: CloudMigrateReport[K] } = {
    databaseUrlMasked: masked,
    preflight: {
      knownTables: [],
      unknownEmptyTables: [],
      unknownTablesWithRows: [],
    },
    migrationsApplied: false,
    dryRun: options.dryRun === true,
  };

  // Compute the exit code before calling io.exit() so the finally-block
  // close() runs cleanly and the catch-block doesn't accidentally catch
  // the __exit__ error that io.exit() throws.
  let exitCode: number;
  try {
    const preflight = await runPreflight(handle);
    report.preflight = preflight;

    if (preflight.unknownTablesWithRows.length > 0) {
      const lines = preflight.unknownTablesWithRows
        .map((t) => `  - ${t.name} (${t.rowCount.toString()} rows)`)
        .join('\n');
      io.writeStderr(
        `${pc.red('coodra cloud-migrate')}: refusing to run — the target database has tables not in the current ` +
          `Coodra schema, AND those tables contain data. Migrating against this database risks corrupting an ` +
          `unrelated application or leaving a stale schema in an inconsistent state.\n\n` +
          `Unknown non-empty tables:\n${lines}\n\n` +
          `If this is intentional (e.g. you removed a module that previously created these tables, and the rows are ` +
          `safe to drop), drop the tables manually and re-run. Otherwise check that DATABASE_URL points at the ` +
          `correct database.\n`,
      );
      if (options.json === true) {
        io.writeStdout(`${formatJson(report)}\n`);
      }
      exitCode = EXIT_ENVIRONMENT_PROBLEM;
    } else if (options.dryRun === true) {
      writeSuccess(io, report, options.json === true, /* applied */ false);
      exitCode = EXIT_OK;
    } else {
      await ensurePgVector(handle.db);
      await migratePostgres(handle.db);
      report.migrationsApplied = true;
      writeSuccess(io, report, options.json === true, /* applied */ true);
      exitCode = EXIT_OK;
    }
  } catch (cause) {
    io.writeStderr(`${pc.red('coodra cloud-migrate')}: migration failed: ${errorMessage(cause)}\n`);
    exitCode = EXIT_USER_RECOVERABLE;
  } finally {
    await handle.close();
  }
  return io.exit(exitCode);
}

async function runPreflight(handle: PostgresHandle): Promise<CloudMigrateReport['preflight']> {
  const tables = await handle.raw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;

  const known: string[] = [];
  const unknownEmpty: string[] = [];
  const unknownWithRows: UnknownTableFinding[] = [];

  for (const row of tables) {
    if (EXPECTED_PUBLIC_TABLES.has(row.table_name)) {
      known.push(row.table_name);
      continue;
    }
    const rowCount = await countRowsSafe(handle, row.table_name);
    if (rowCount > 0n) {
      unknownWithRows.push({ name: row.table_name, rowCount });
    } else {
      unknownEmpty.push(row.table_name);
    }
  }

  return {
    knownTables: known,
    unknownEmptyTables: unknownEmpty,
    unknownTablesWithRows: unknownWithRows,
  };
}

/**
 * Count rows in a `public` table by name. The name comes from
 * `information_schema.tables` — a trusted catalog — but we still pass it
 * through postgres-js's identifier helper (`handle.raw(name)`) which
 * quotes and escapes it. A bigint return handles tables exceeding 2^53.
 */
async function countRowsSafe(handle: PostgresHandle, tableName: string): Promise<bigint> {
  const rows = await handle.raw<Array<{ c: string }>>`
    SELECT COUNT(*)::text AS c FROM ${handle.raw(tableName)}
  `;
  return BigInt(rows[0]?.c ?? '0');
}

function writeSuccess(io: CloudMigrateIO, report: CloudMigrateReport, json: boolean, applied: boolean): void {
  if (json) {
    io.writeStdout(`${formatJson(report)}\n`);
    return;
  }
  const verb = applied ? pc.green('applied') : pc.cyan('preflight ok');
  io.writeStdout(
    `coodra cloud-migrate: ${verb} against ${report.databaseUrlMasked}\n` +
      `  known tables found: ${report.preflight.knownTables.length}\n` +
      `  unknown empty tables: ${report.preflight.unknownEmptyTables.length}\n` +
      (applied ? '' : '  (--dry-run — migrations not applied)\n'),
  );
}

function formatJson(report: CloudMigrateReport): string {
  return JSON.stringify(
    {
      ...report,
      preflight: {
        ...report.preflight,
        unknownTablesWithRows: report.preflight.unknownTablesWithRows.map((t) => ({
          name: t.name,
          rowCount: t.rowCount.toString(),
        })),
      },
    },
    null,
    2,
  );
}

/**
 * Mask credentials in a postgres URL so logs/JSON don't leak the password.
 * Returns `postgres://user:***@host/db` shape; passes through unparseable
 * strings unchanged (with the password segment replaced if recognisable).
 */
function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password !== '') {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url.replace(/:[^:@/]+@/, ':***@');
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
