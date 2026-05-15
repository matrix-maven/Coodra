import { createDb, type DbHandle } from '@coodra/db';
import { createLogger } from '@coodra/shared';

import type { HooksBridgeEnv } from '../config/env.js';

/**
 * `apps/hooks-bridge/src/lib/db.ts` — typed factory for the per-process
 * DB client. Mirrors `apps/mcp-server/src/lib/db.ts` post Module 03 S4:
 * always opens a SQLite handle, regardless of `mode`. Hooks Bridge is
 * a local service per `system-architecture.md` §1.
 */

const dbLibLogger = createLogger('hooks-bridge.lib-db');

export interface CreateHooksBridgeDbClientOptions {
  /** Auth-strategy hint, forwarded to createDb but not used for DB choice. */
  readonly mode?: 'solo' | 'team';
  /** Override the SQLite path (defaults to env.COODRA_SQLITE_PATH). */
  readonly sqlitePath?: string;
  /** Test marker — forces an in-memory DB with no extension load. */
  readonly _testOverrideInMemory?: boolean;
}

export interface HooksBridgeDbClient {
  readonly handle: DbHandle;
  close(): Promise<void>;
}

export function createHooksBridgeDbClient(options: CreateHooksBridgeDbClientOptions = {}): HooksBridgeDbClient {
  const handle: DbHandle = options._testOverrideInMemory
    ? createDb({
        kind: 'local',
        mode: 'solo',
        sqlite: { path: ':memory:', loadVecExtension: false, skipPragmas: true },
      })
    : createDb({
        kind: 'local',
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.sqlitePath !== undefined ? { sqlite: { path: options.sqlitePath } } : {}),
      });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      if (handle.kind === 'sqlite') {
        handle.close();
      } else {
        await handle.close();
      }
    } catch (err) {
      dbLibLogger.warn(
        { event: 'db_close_failed', kind: handle.kind, err: err instanceof Error ? err.message : String(err) },
        'db handle close threw; swallowing (shutdown path)',
      );
    }
  };

  dbLibLogger.info({ event: 'db_client_opened', kind: handle.kind }, 'db client opened');

  return { handle, close };
}

/**
 * Resolves the SQLite path to use given the typed env. Tests pass a
 * synthesised env so the function stays pure.
 */
export function resolveSqlitePathFromEnv(env: HooksBridgeEnv): string | undefined {
  return env.COODRA_SQLITE_PATH;
}
