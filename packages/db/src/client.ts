import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createLogger, InternalError, ValidationError } from '@coodra/shared';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as sqliteVec from 'sqlite-vec';

import * as postgresSchema from './schema/postgres.js';
import * as sqliteSchema from './schema/sqlite.js';

const clientLogger = createLogger('db.sqlite-vec-loader');

/**
 * The SQLite Drizzle client shape used by solo-mode services and by every
 * local service in team mode (per `system-architecture.md` §4.2).
 */
export type SqliteDb = BetterSQLite3Database<typeof sqliteSchema>;

/**
 * The Postgres Drizzle client shape used by cloud services in team mode.
 * Local services never call `createPostgresDb` in team mode — the Sync
 * Daemon is the only dual-connection consumer.
 */
export type PostgresDb = PostgresJsDatabase<typeof postgresSchema>;

export interface CreateSqliteDbOptions {
  /**
   * Filesystem path to the SQLite database. `:memory:` is accepted for
   * tests. Defaults to `~/.coodra/data.db` when omitted, with the
   * parent directory created on demand.
   */
  path?: string;

  /** Skip setting the recommended PRAGMAs (for ephemeral test DBs). */
  skipPragmas?: boolean;

  /**
   * Load the `sqlite-vec` loadable extension on the raw connection so the
   * `context_packs_vec` vec0 virtual table (and future vec0 tables) are
   * usable by this handle. Defaults to `true`.
   *
   * Failure handling (per decision 2026-04-22 22:08):
   *   - `NODE_ENV=test` or `COODRA_REQUIRE_VEC=1` → throw
   *     `InternalError('sqlite_vec_unavailable')`. Dev and test must not
   *     silently degrade — a missing extension would hide embedding-index
   *     regressions.
   *   - otherwise → log a WARN line tagged `sqlite_vec_unavailable` and
   *     continue. This is the production fail-open path
   *     (`system-architecture.md` §7): the server still serves contextual
   *     reads and falls back to LIKE-over-`content_excerpt`.
   */
  loadVecExtension?: boolean;
}

export interface CreatePostgresDbOptions {
  /** PG connection string. Required when mode is `team`. */
  databaseUrl: string;
  /** Connection pool max size. Defaults to 5 per service instance per §4.2. */
  max?: number;
  /**
   * Must be `false` when connecting through Supabase's Supavisor transaction
   * pooler. Defaults to `false` because that is the production target; a
   * direct Postgres connection also tolerates `prepare: false`.
   */
  prepare?: boolean;
}

export interface SqliteHandle {
  readonly kind: 'sqlite';
  readonly db: SqliteDb;
  readonly raw: BetterSqliteDatabase;
  readonly close: () => void;
}

export interface PostgresHandle {
  readonly kind: 'postgres';
  readonly db: PostgresDb;
  readonly raw: Sql;
  readonly close: () => Promise<void>;
}

export type DbHandle = SqliteHandle | PostgresHandle;

const RECOMMENDED_PRAGMAS: ReadonlyArray<string> = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'cache_size = -64000',
  'foreign_keys = ON',
  'temp_store = MEMORY',
];

/** Expand a leading `~` to the OS home directory. */
function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Resolve the effective SQLite path, applying defaults and home-expansion.
 *
 * Precedence (highest first), per integration finding 2026-04-27 (post-08a
 * walk):
 *   1. `input` argument (explicit caller override; e.g. `coodra doctor`
 *      passes `<coodra-home>/data.db` directly).
 *   2. `COODRA_SQLITE_PATH` env var (per-process override).
 *   3. `COODRA_HOME` env var (per-machine umbrella; bridge + mcp-server
 *      daemons spawned by `coodra start` get this through the plist /
 *      systemd unit / fallback environment block so they write to the
 *      same data.db the CLI tools read from).
 *   4. `~/.coodra/data.db` (per-user fallback).
 *
 * Why this layering matters: pre-fix, daemons spawned by the CLI ignored
 * `COODRA_HOME` for the DB path and resolved `~/.coodra/data.db`
 * against the OS user's homedir — so the daemon wrote audit rows to
 * a DB at one path while doctor + status read from another path. Test
 * environments that set `COODRA_HOME=/tmp/...` saw daemons silently
 * polluting the user's real `~/.coodra/data.db`.
 */
export function resolveSqlitePath(input: string | undefined): string {
  if (input !== undefined && input !== '') {
    return input === ':memory:' ? ':memory:' : resolve(expandHome(input));
  }
  const sqlitePathEnv = process.env.COODRA_SQLITE_PATH;
  if (sqlitePathEnv !== undefined && sqlitePathEnv !== '') {
    return sqlitePathEnv === ':memory:' ? ':memory:' : resolve(expandHome(sqlitePathEnv));
  }
  const coodraHomeEnv = process.env.COODRA_HOME;
  if (coodraHomeEnv !== undefined && coodraHomeEnv !== '') {
    return resolve(join(expandHome(coodraHomeEnv), 'data.db'));
  }
  return resolve(expandHome('~/.coodra/data.db'));
}

/**
 * Whether the current process requires sqlite-vec to load successfully.
 * In `test` and explicit opt-in contexts, a silent fallback would hide
 * embedding-path regressions; so we throw. Production defaults to WARN.
 * Environment variables are re-read on every call so test code can flip
 * `COODRA_REQUIRE_VEC` at runtime without re-importing the module.
 */
function vecLoadIsRequired(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.COODRA_REQUIRE_VEC === '1';
}

/**
 * Attempt to load the `sqlite-vec` loadable extension on the given raw
 * `better-sqlite3` handle. On failure: throw when the process is in a
 * must-not-silently-degrade environment, otherwise WARN and continue.
 * Exported so integration tests can cover both branches directly.
 */
export function loadSqliteVecOrFail(raw: BetterSqliteDatabase): void {
  let loadablePath = '<unknown>';
  try {
    try {
      loadablePath = sqliteVec.getLoadablePath();
    } catch {
      // `getLoadablePath` can throw on unsupported platforms before we even
      // reach `load`; keep the placeholder so the log line still has a slot.
    }
    sqliteVec.load(raw);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const meta = {
      event: 'sqlite_vec_unavailable',
      loadablePath,
      platform: process.platform,
      arch: process.arch,
      err: message,
    };
    if (vecLoadIsRequired()) {
      clientLogger.error(meta, 'sqlite_vec_unavailable: strict mode, aborting SQLite handle creation');
      throw new InternalError(`sqlite_vec_unavailable: ${message}`, cause);
    }
    clientLogger.warn(meta, 'sqlite_vec_unavailable: falling back to LIKE search path');
  }
}

/**
 * Open (or create) a SQLite-backed Drizzle client per §4.1. The returned
 * handle carries a `.close()` the caller is expected to invoke during
 * shutdown. The `sqlite-vec` loadable extension is loaded by default;
 * see `CreateSqliteDbOptions.loadVecExtension` for the failure-handling
 * contract.
 */
export function createSqliteDb(options: CreateSqliteDbOptions = {}): SqliteHandle {
  const path = resolveSqlitePath(options.path);
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new Database(path);
  if (options.skipPragmas !== true) {
    for (const pragma of RECOMMENDED_PRAGMAS) {
      raw.pragma(pragma);
    }
  }
  if (options.loadVecExtension !== false) {
    try {
      loadSqliteVecOrFail(raw);
    } catch (err) {
      raw.close();
      throw err;
    }
  }
  const db = drizzleSqlite(raw, { schema: sqliteSchema });
  return {
    kind: 'sqlite',
    db,
    raw,
    close: () => {
      raw.close();
    },
  };
}

/**
 * Open a Postgres-backed Drizzle client per §4.2. Throws when
 * `databaseUrl` is empty.
 */
export function createPostgresDb(options: CreatePostgresDbOptions): PostgresHandle {
  if (!options.databaseUrl || typeof options.databaseUrl !== 'string') {
    throw new ValidationError('createPostgresDb: databaseUrl is required and must be a non-empty string');
  }
  const raw = postgres(options.databaseUrl, {
    max: options.max ?? 5,
    prepare: options.prepare ?? false,
    // Silence postgres.js's default `console.log(notice)` handler. Idem-
    // potent DDL like `CREATE EXTENSION IF NOT EXISTS vector`, `CREATE
    // SCHEMA IF NOT EXISTS drizzle`, `CREATE TABLE IF NOT EXISTS …`
    // produce NOTICE-level messages whose default printer pollutes
    // wizard / migration output. We don't surface them anywhere
    // actionable; callers that genuinely care can wrap their own
    // handle with a custom logger. (2026-05-11, Phase B clarity pass.)
    onnotice: () => {},
  });
  const db = drizzlePostgres(raw, { schema: postgresSchema });
  return {
    kind: 'postgres',
    db,
    raw,
    close: async () => {
      await raw.end({ timeout: 5 });
    },
  };
}

/**
 * Discriminated factory options.
 *
 * `kind: 'local'` always returns SQLite. Used by every local service —
 * `apps/mcp-server`, `apps/hooks-bridge`, `apps/web` (Module 04) — in
 * BOTH solo and team mode. `system-architecture.md §1` is unambiguous
 * here: "In both solo and team modes, **local services always write to
 * local SQLite**." Module 03 S4 makes the code match the architecture.
 *
 * `kind: 'cloud'` always returns Postgres. Used by the future Sync
 * Daemon and the future cloud-api. Local code never picks this branch.
 *
 * `mode` (`'solo' | 'team'`) is a hint for any caller that wants to
 * branch on auth strategy or future logging tags. It does NOT dictate
 * DB choice. Module 02 S4's `COODRA_DB_OVERRIDE_MODE` env knob —
 * introduced as a stop-gap for the team-mode-auth + sqlite local-dev
 * scenario — is removed in Module 03 S4 because the new `kind`
 * discriminator makes the override unnecessary.
 *
 * Closes verification finding §8.3.
 */
export type CreateDbOptions =
  | {
      readonly kind: 'local';
      readonly mode?: 'solo' | 'team';
      readonly sqlite?: CreateSqliteDbOptions;
    }
  | {
      readonly kind: 'cloud';
      readonly mode?: 'solo' | 'team';
      readonly postgres?: CreatePostgresDbOptions;
    };

/**
 * Discriminated factory. `kind: 'local'` → SQLite (regardless of `mode`),
 * `kind: 'cloud'` → Postgres. The Sync Daemon (Module 03+) is the only
 * process that holds both simultaneously; it constructs each handle
 * directly via `createSqliteDb` / `createPostgresDb` rather than going
 * through this factory twice.
 *
 * Default behaviour when `kind` is omitted: `'local'`. This matches
 * Module 01's "always SQLite for local services" architectural note
 * and keeps the call sites that pass nothing (test harnesses) on the
 * SQLite path.
 */
export function createDb(options: CreateDbOptions = { kind: 'local' }): DbHandle {
  if (options.kind === 'cloud') {
    if (options.postgres) {
      return createPostgresDb(options.postgres);
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new ValidationError(
        'createDb: kind=cloud requires either options.postgres.databaseUrl or the DATABASE_URL env var',
      );
    }
    return createPostgresDb({ databaseUrl });
  }
  // kind: 'local' (default).
  return createSqliteDb(options.sqlite ?? {});
}
