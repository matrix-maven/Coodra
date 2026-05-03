import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createDb, type DbHandle } from '@coodra/contextos-db';

/**
 * `apps/web/lib/db.ts` — storage adapter per spec §7 + OQ-1 lock.
 *
 * Solo mode → direct better-sqlite3 against `~/.contextos/data.db`.
 * Team mode → Drizzle pg pool against `DATABASE_URL`.
 *
 * Module-level cache: one DbHandle per Node.js process. In team mode this
 * means one Drizzle pool per Next.js worker; pool config is `max=10`,
 * appropriate for the v1 traffic profile (single-org, ~10 concurrent
 * operators per worker).
 *
 * Bridge / MCP server stay authoritative WRITERS for audit-trail tables
 * (run_events, decisions, context_packs, policy_decisions). The web only
 * writes to mutation tables the CLI already writes to (policies,
 * policy_rules, kill_switches) and reads everything else.
 */

let cached: DbHandle | undefined;

export function createWebDb(): DbHandle {
  if (cached !== undefined) return cached;
  const mode = process.env.CONTEXTOS_MODE ?? 'solo';
  if (mode === 'team') {
    const url = process.env.DATABASE_URL;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        'createWebDb: CONTEXTOS_MODE=team requires DATABASE_URL. Set it in apps/web/.env.local (copy from repo-root .env).',
      );
    }
    cached = createDb({ kind: 'cloud', postgres: { databaseUrl: url } });
    return cached;
  }
  // Solo
  const home = process.env.CONTEXTOS_HOME ?? resolve(homedir(), '.contextos');
  const path = resolve(home, 'data.db');
  cached = createDb({ kind: 'local', sqlite: { path } });
  return cached;
}

/**
 * Test-only helper to clear the cached handle. Production code never
 * calls this; tests use it between cases that swap CONTEXTOS_MODE.
 */
export function _clearWebDbCache(): void {
  cached?.close();
  cached = undefined;
}
