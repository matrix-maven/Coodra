import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createDb, type DbHandle } from '@coodra/db';

import { resolveDeploymentMode, resolveIdentityMode } from '@/lib/deployment-mode';

/**
 * web-v2 storage adapter — produces a `DbHandle` shaped per the current
 * deployment mode:
 *
 *   - `local-solo` / `local-team`:
 *       Open `<COODRA_HOME>/data.db` via better-sqlite3 (local SQLite
 *       primary store). The Sync Daemon mirrors to cloud Postgres async
 *       when in team mode.
 *
 *   - `team-hosted`:
 *       Open the cloud Postgres directly via the postgres-js driver.
 *       The web app is running on a server with no ~/.coodra at all —
 *       everything reads + writes from cloud. Throws if DATABASE_URL is
 *       missing because that's an unrecoverable misconfig in this mode.
 *
 * Module-level cache: one handle per Next.js worker. The cache key is
 * the resolved deployment mode so a single dev process can't reuse a
 * sqlite handle across an env flip.
 */

interface CacheEntry {
  readonly handle: DbHandle;
  readonly mode: ReturnType<typeof resolveDeploymentMode>;
}

let cached: CacheEntry | undefined;

export function createWebDb(): DbHandle {
  const mode = resolveDeploymentMode();
  if (cached !== undefined && cached.mode === mode) return cached.handle;

  if (mode === 'team-hosted') {
    const url = process.env.DATABASE_URL;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        'createWebDb: COODRA_DEPLOYMENT=team-hosted requires DATABASE_URL. Set it in deployment env (Vercel project settings, fly secrets, docker -e, etc).',
      );
    }
    // Cap the postgres-js pool at 5 connections per Next.js worker.
    // Next.js dev mode rebuilds modules on hot-reload but doesn't always
    // close prior DB handles synchronously; on Supabase's free tier
    // (~60 connection cap shared across project), the default `max: 10`
    // gets exhausted after a few reloads. 5 is enough headroom for SSR
    // page renders + the server-action bursts; production deployments
    // override via `COODRA_PG_MAX` if they need more.
    const max = Number.parseInt(process.env.COODRA_PG_MAX ?? '5', 10);
    const handle = createDb({
      kind: 'cloud',
      postgres: { databaseUrl: url, max: Number.isFinite(max) && max > 0 ? max : 5 },
    });
    cached = { handle, mode };
    return handle;
  }

  // local-solo / local-team: SQLite-primary.
  const home = process.env.COODRA_HOME ?? resolve(homedir(), '.coodra');
  const path = resolve(home, 'data.db');
  const handle = createDb({ kind: 'local', sqlite: { path } });
  cached = { handle, mode };
  return handle;
}

/**
 * Phase G slice G.8+ — cloud-Postgres handle for queries that require it
 * REGARDLESS of where the web is running (laptop OR cloud).
 *
 * `team_invites` is the canonical example: the row lives in cloud
 * Postgres (single source of truth across teammates), single-use jti
 * needs cloud-side enforcement, and the redeem flow runs server-side
 * regardless of admin's machine. Local SQLite has the schema for parity
 * but no data — invite operations against the SQLite mirror would be
 * meaningless.
 *
 * Pre-Phase-G this was implicitly the team-hosted-only path. In Phase G's
 * unified model, local-team admins also need to mint/list invites from
 * cloud Postgres because their teammates will redeem against the SAME
 * cloud row (the laptop's own SQLite is irrelevant to invite redemption).
 *
 * Throws in solo mode (no cloud at all) and when DATABASE_URL is unset.
 * Cached per-process like createWebDb.
 */
let cachedCloud: Extract<DbHandle, { kind: 'postgres' }> | undefined;

export function createWebCloudDb(): Extract<DbHandle, { kind: 'postgres' }> {
  if (cachedCloud !== undefined) return cachedCloud;

  if (resolveIdentityMode() !== 'team') {
    throw new Error(
      'createWebCloudDb: requires team mode. Run `coodra team init` to set up cloud Postgres, or `coodra login` to refresh your team session.',
    );
  }
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(
      'createWebCloudDb: DATABASE_URL is unset. In team mode the web needs cloud Postgres for invite operations. ' +
        'Set DATABASE_URL in ~/.coodra/.env (laptop) or the deployment env (cloud).',
    );
  }
  const max = Number.parseInt(process.env.COODRA_PG_MAX ?? '5', 10);
  const handle = createDb({
    kind: 'cloud',
    postgres: { databaseUrl: url, max: Number.isFinite(max) && max > 0 ? max : 5 },
  });
  if (handle.kind !== 'postgres') {
    throw new Error('createWebCloudDb: createDb({ kind: \'cloud\' }) returned non-postgres handle (impossible)');
  }
  cachedCloud = handle;
  return handle;
}
