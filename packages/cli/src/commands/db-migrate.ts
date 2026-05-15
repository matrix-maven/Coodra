import { readdir } from 'node:fs/promises';

import { migrateSqlite, resolveMigrationsFolder } from '@coodra/db';
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { readPidStatus } from '../lib/pid-status.js';
import { bundledMigrationsDir } from '../lib/runtime-paths.js';
import { pc } from '../ui/index.js';

/**
 * `coodra db migrate` — apply pending Drizzle migrations to
 * `~/.coodra/data.db`.
 *
 * Idempotent. Re-running with no pending migrations is a no-op (exit 0).
 *
 * Refuses to run while daemons are still writing to the DB unless
 * `--with-daemons-running` is set. The daemons check uses the
 * existing `pid-status.ts` helper from M08a — alive PID files for
 * any of {mcp-server, hooks-bridge, sync-daemon} block the run with
 * exit 1 + a `coodra stop` remediation pointer.
 *
 * `--dry-run` reports what would change (file count vs applied count)
 * without invoking the migrator. Useful for operator verification
 * before a `coodra upgrade` flow.
 */

const TRACKED_DAEMON_UNITS = ['mcp-server', 'hooks-bridge', 'sync-daemon'] as const;

export interface DbMigrateOptions {
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly withDaemonsRunning?: boolean;
}

export interface DbMigrateIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  readonly coodraHome?: string;
  /**
   * Override the migrations directory for tests. Production resolves
   * to the bundled `dist/migrations/sqlite` via `runtime-paths.ts`.
   */
  readonly migrationsDir?: string;
}

export const DEFAULT_DB_MIGRATE_IO: DbMigrateIO = {
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

interface DbMigrateJson {
  readonly ok: boolean;
  readonly applied: number;
  readonly pendingBefore: number;
  readonly totalAfter: number;
  readonly dryRun: boolean;
  readonly daemonsRunning?: ReadonlyArray<{ readonly unit: string; readonly pid: number }>;
  readonly error?: string;
}

export async function runDbMigrateCommand(options: DbMigrateOptions, ioOverride?: DbMigrateIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_DB_MIGRATE_IO;
  const json = options.json === true;
  const dryRun = options.dryRun === true;

  const homePath = io.coodraHome ?? resolveCoodraHome();

  // Daemon-running check (skipped when --with-daemons-running OR --dry-run).
  if (!dryRun && options.withDaemonsRunning !== true) {
    const aliveUnits: { unit: string; pid: number }[] = [];
    for (const unit of TRACKED_DAEMON_UNITS) {
      const status = await readPidStatus(homePath, unit);
      if (status.state === 'alive') aliveUnits.push({ unit, pid: status.pid });
    }
    if (aliveUnits.length > 0) {
      const list = aliveUnits.map((u) => `${u.unit} (pid ${u.pid})`).join(', ');
      if (json) {
        const payload: DbMigrateJson = {
          ok: false,
          applied: 0,
          pendingBefore: 0,
          totalAfter: 0,
          dryRun: false,
          daemonsRunning: aliveUnits,
          error: `${aliveUnits.length} daemon(s) still running`,
        };
        io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        io.writeStderr(
          `${pc.red('error')}: ${aliveUnits.length} daemon(s) still running: ${list}.\n` +
            `  Run \`coodra stop\` first, or pass --with-daemons-running if you understand the risks.\n`,
        );
      }
      io.exit(EXIT_USER_RECOVERABLE);
      return;
    }
  }

  const migrationsDir: string | null = io.migrationsDir ?? resolveMigrationsDirForCli();
  const dbPath = resolveCoodraDataDb(homePath);
  // The migration set includes the `sqlite-vec` vec0 virtual table on
  // migration 0001 — opening without the extension errors at apply
  // time. Match init.ts's load posture.
  const handle = await openLocalDb(dbPath, { loadVecExtension: true });
  try {
    const beforeCount = countAppliedMigrations(handle.raw);
    const onDiskMigrations = await listOnDiskMigrations(migrationsDir);
    const pendingBefore = Math.max(0, onDiskMigrations.length - beforeCount);

    if (dryRun) {
      const payload: DbMigrateJson = {
        ok: true,
        applied: 0,
        pendingBefore,
        totalAfter: beforeCount,
        dryRun: true,
      };
      if (json) {
        io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        io.writeStdout(
          `${pc.cyan('—')} dry-run: ${pendingBefore} pending migration(s) (applied: ${beforeCount}, on-disk: ${onDiskMigrations.length}).\n`,
        );
      }
      io.exit(EXIT_OK);
      return;
    }

    if (migrationsDir === null) {
      migrateSqlite(handle.db);
    } else {
      migrateSqlite(handle.db, migrationsDir);
    }
    const afterCount = countAppliedMigrations(handle.raw);
    const applied = Math.max(0, afterCount - beforeCount);

    const payload: DbMigrateJson = {
      ok: true,
      applied,
      pendingBefore,
      totalAfter: afterCount,
      dryRun: false,
    };
    if (json) {
      io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (applied === 0) {
      io.writeStdout(
        `${pc.green('✓')} db migrate: no pending migrations (already at head; ${afterCount} applied total).\n`,
      );
    } else {
      io.writeStdout(`${pc.green('✓')} db migrate: applied ${applied} new migration(s) (${afterCount} total).\n`);
    }
    io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

/**
 * Resolve the SQLite migrations directory the runtime ships. In an
 * installed CLI the bundled `dist/migrations/sqlite` is used; in dev
 * loops we fall back to `migrateSqlite`'s own default
 * (`MIGRATIONS_FOLDER.sqlite`). Returning null lets the caller defer
 * to that default.
 */
function resolveMigrationsDirForCli(): string | null {
  return bundledMigrationsDir('sqlite');
}

interface RawSqliteHandle {
  prepare(sql: string): { get(): unknown };
}

function countAppliedMigrations(raw: RawSqliteHandle): number {
  // Drizzle creates `__drizzle_migrations` on first migrate. Until
  // then, the table doesn't exist; treat as 0 applied.
  try {
    const stmt = raw.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations');
    const row = stmt.get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

async function listOnDiskMigrations(dir: string | null): Promise<string[]> {
  if (dir === null) return [];
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => /^\d{4,}_.+\.sql$/.test(f)).sort();
  } catch {
    return [];
  }
}

// Re-export so the program-level wiring can call `resolveMigrationsFolder`
// for diagnostics if needed without taking another dep on @coodra/db.
void resolveMigrationsFolder;
