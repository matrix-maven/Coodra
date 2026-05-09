import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createDb, type DbHandle } from '@coodra/contextos-db';

/**
 * web-v2 storage adapter — mirrors apps/web/lib/db.ts. Solo mode opens
 * `~/.contextos/data.db` via better-sqlite3; team mode opens a Drizzle
 * pg pool against `DATABASE_URL`. Module-level cache: one handle per
 * Next.js worker.
 */

let cached: DbHandle | undefined;

export function createWebDb(): DbHandle {
  if (cached !== undefined) return cached;
  const mode = process.env.CONTEXTOS_MODE ?? 'solo';
  if (mode === 'team') {
    const url = process.env.DATABASE_URL;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('createWebDb: CONTEXTOS_MODE=team requires DATABASE_URL.');
    }
    cached = createDb({ kind: 'cloud', postgres: { databaseUrl: url } });
    return cached;
  }
  const home = process.env.CONTEXTOS_HOME ?? resolve(homedir(), '.contextos');
  const path = resolve(home, 'data.db');
  cached = createDb({ kind: 'local', sqlite: { path } });
  return cached;
}
