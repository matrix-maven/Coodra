import { createPostgresDb, ensurePgVector, migratePostgres, type PostgresHandle } from '@coodra/db';
import { sql } from 'drizzle-orm';

/**
 * `packages/cli/src/lib/team-init/postgres-bootstrap.ts` — Phase B
 * (clarity-pass-plan, 2026-05-11). Postgres preflight + schema bootstrap
 * for the admin onboarding wizard.
 *
 * The single async function `bootstrapPostgres` runs the same three-step
 * sequence that `coodra team setup` does today, but returns a
 * structured discriminated-union result instead of throwing — so both
 * the CLI wizard and the web server action can branch on the error
 * code without parsing stack traces.
 *
 * Sequence:
 *   1. Open a Postgres handle and run `SELECT 1` to prove the URL works.
 *   2. (Unless `skipPgvector`) run `CREATE EXTENSION IF NOT EXISTS vector`.
 *   3. Apply Drizzle migrations from the bundled `drizzle/postgres/`
 *      folder. Idempotent — re-runs on an already-migrated database are
 *      no-ops.
 *
 * Every failure mode returns a `{ ok: false, error: <stable-code>,
 * howToFix: <string>, underlyingError: <pg or drizzle message> }` shape
 * so callers can render user-facing remediation text without leaking
 * raw error strings. This pattern matches the discriminated-union
 * soft-failure convention used by M02 S8 tools
 * (`essentialsforclaude/09-common-patterns.md` §9.1.2).
 */

export interface PostgresBootstrapInput {
  readonly databaseUrl: string;
  /**
   * Skip the `CREATE EXTENSION vector` step. Use when the operator's
   * Postgres role lacks CREATE EXTENSION privileges (some managed
   * Postgres providers) OR when the operator has already installed it
   * via a SQL editor / dashboard. NL Assembly degrades gracefully on
   * machines without pgvector — search falls back to plain LIKE.
   */
  readonly skipPgvector?: boolean;
}

export type PostgresBootstrapResult =
  | {
      readonly ok: true;
      readonly migrationsApplied: number;
      readonly pgvectorInstalled: boolean;
      readonly serverVersion: string;
    }
  | {
      readonly ok: false;
      readonly error: 'connect_failed' | 'pgvector_unavailable' | 'migration_failed';
      readonly howToFix: string;
      readonly underlyingError: string;
    };

/**
 * Run the preflight + migration sequence. Never throws — every failure
 * returns a soft-failure shape with a stable error code.
 */
export async function bootstrapPostgres(input: PostgresBootstrapInput): Promise<PostgresBootstrapResult> {
  let handle: PostgresHandle;
  try {
    handle = createPostgresDb({ databaseUrl: input.databaseUrl });
  } catch (err) {
    return {
      ok: false,
      error: 'connect_failed',
      howToFix:
        "Couldn't parse the DATABASE_URL. Make sure it has the shape " +
        '`postgresql://user:password@host:port/database` (Supabase: Settings → Database → "URI" connection string).',
      underlyingError: extractMessage(err),
    };
  }

  // Step 1 — verify reachability via `SELECT 1` AND capture the server
  // version string so we can show it in the wizard's success line.
  let serverVersion: string;
  try {
    const rows = await handle.db.execute<{ version: string }>(sql`SELECT version() AS version`);
    const firstRow = rowsToArray(rows)[0];
    serverVersion = typeof firstRow?.version === 'string' ? firstRow.version : 'unknown';
  } catch (err) {
    handle.close?.();
    return {
      ok: false,
      error: 'connect_failed',
      howToFix:
        "Couldn't connect to Postgres. Check that the URL is correct, the database is reachable from this machine " +
        '(no firewall, no VPN-only host), and the user/password authenticate. For Supabase: try the URL from the ' +
        'dashboard\'s "Connection string → URI" tab.',
      underlyingError: extractMessage(err),
    };
  }

  // Step 2 — pgvector. The CREATE EXTENSION is idempotent. We treat
  // permission errors here as a recoverable warning rather than a hard
  // failure — see the howToFix block.
  let pgvectorInstalled = false;
  if (input.skipPgvector !== true) {
    try {
      await ensurePgVector(handle.db);
      pgvectorInstalled = true;
    } catch (err) {
      handle.close?.();
      return {
        ok: false,
        error: 'pgvector_unavailable',
        howToFix:
          'pgvector is unavailable on this Postgres role. Options: ' +
          '(1) On Supabase, open SQL editor and run `CREATE EXTENSION vector;` once, then re-run this wizard. ' +
          '(2) Re-run with `--skip-pgvector` — NL Assembly degrades gracefully to plain LIKE search. ' +
          '(3) Ask your DB admin to grant `CREATE EXTENSION` privileges to your role.',
        underlyingError: extractMessage(err),
      };
    }
  }

  // Step 3 — apply Drizzle migrations. Idempotent via Drizzle's
  // __drizzle_migrations bookkeeping table. We can't easily count how
  // many migrations were APPLIED (vs SKIPPED) without reading that
  // table; report the count of available migration files instead.
  //
  // `migratePostgres` defaults to the migrations folder bundled inside
  // `@coodra/db` — same default that `team setup` uses, so
  // the wizard and the legacy command share a single migrations source.
  try {
    await migratePostgres(handle.db);
  } catch (err) {
    handle.close?.();
    return {
      ok: false,
      error: 'migration_failed',
      howToFix:
        'Drizzle could not apply one or more migrations. The database may have an inconsistent schema ' +
        '(e.g., manual edits, partial prior install). Inspect `__drizzle_migrations` in the database to see ' +
        'which step failed; you may need to drop the broken object or roll back the partial state and re-run.',
      underlyingError: extractMessage(err),
    };
  }

  // Read the count of applied migrations from the bookkeeping table.
  // This is "available migrations" but matches "applied migrations"
  // after a successful migratePostgres() call.
  const migrationsApplied = await readAppliedMigrationCount(handle);

  handle.close?.();
  return { ok: true, migrationsApplied, pgvectorInstalled, serverVersion: condensVersion(serverVersion) };
}

async function readAppliedMigrationCount(handle: PostgresHandle): Promise<number> {
  try {
    const rows = await handle.db.execute<{ count: string | number }>(
      sql`SELECT count(*) AS count FROM drizzle.__drizzle_migrations`,
    );
    const first = rowsToArray(rows)[0];
    const raw = first?.count;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Drizzle's `db.execute()` returns shapes that differ across drivers
 * (postgres.js vs node-postgres). Normalise to a plain array. We only
 * care about the rows here, not the metadata.
 */
function rowsToArray(rows: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  if (
    typeof rows === 'object' &&
    rows !== null &&
    'rows' in rows &&
    Array.isArray((rows as { rows: unknown[] }).rows)
  ) {
    return (rows as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    // Walk the cause chain so postgres.js / drizzle wrap-then-rethrow
    // doesn't bury the actual SQLSTATE message.
    const messages: string[] = [err.message];
    let cur: unknown = (err as { cause?: unknown }).cause;
    while (cur instanceof Error && messages.length < 5) {
      messages.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return messages.join(' → ');
  }
  return String(err);
}

function condensVersion(version: string): string {
  // `version()` returns something like:
  //   "PostgreSQL 17.4 on aarch64-unknown-linux-gnu, compiled by gcc..."
  // Trim everything after the first "on " for a clean display string.
  const idx = version.indexOf(' on ');
  if (idx > 0) return version.slice(0, idx);
  return version;
}
