import { readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { MIGRATIONS_FOLDER } from '@coodra/db';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

export const dbMigrationsHeadCheck: Check = {
  id: 4,
  name: 'DB migrations are at head',
  severity: 'red',
  async run(ctx) {
    try {
      await access(ctx.dataDb);
    } catch {
      return {
        status: 'skipped',
        detail: `${ctx.dataDb} missing — check 3 covers this`,
      };
    }

    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return {
        status: 'red',
        detail: `cannot open ${ctx.dataDb}: ${(err as Error).message}`,
        remediation: 'See check 3.',
      };
    }
    try {
      const expected = countSqliteMigrationsOnDisk();
      const applied = handle.raw.prepare(`SELECT COUNT(*) as c FROM "__drizzle_migrations"`).get() as
        | { c: number }
        | undefined;
      const appliedCount = applied?.c ?? 0;
      if (appliedCount === expected) {
        return { status: 'green', detail: `${appliedCount}/${expected} migrations applied` };
      }
      if (appliedCount < expected) {
        return {
          status: 'red',
          detail: `${appliedCount}/${expected} migrations applied — DB is behind`,
          remediation: 'Re-run `coodra init` to apply pending migrations.',
        };
      }
      return {
        status: 'yellow',
        detail: `${appliedCount} migrations applied but disk has ${expected} — likely a downgrade`,
        remediation: 'Reinstall Coodra at the version that matches this data.db, or run `coodra init --force`.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table') && msg.includes('__drizzle_migrations')) {
        return {
          status: 'red',
          detail: 'data.db has no __drizzle_migrations table — migrations were never applied',
          remediation: 'Run `coodra init` to apply migrations.',
        };
      }
      return { status: 'red', detail: msg, remediation: 'Inspect data.db; back up and re-init if corrupt.' };
    } finally {
      try {
        handle.close();
      } catch {
        // ignore
      }
    }
  },
};

function countSqliteMigrationsOnDisk(): number {
  try {
    const entries = readdirSync(MIGRATIONS_FOLDER.sqlite);
    return entries.filter((e) => e.endsWith('.sql')).length;
  } catch {
    // If we can't read the migrations folder, fall back to 0 — the runtime
    // assertion will land as "DB ahead" and surface the underlying error.
    return 0;
  }
}
