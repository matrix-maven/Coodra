import { access } from 'node:fs/promises';

import { createPostgresDb } from '@coodra/db';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 04a doctor surface — sync lag.
 *
 * Compares the newest `runs.started_at` on local SQLite with the
 * newest on cloud Postgres. The delta is "how far behind cloud is."
 * (`started_at` is the column name; M04a's original check used
 * `created_at` which doesn't exist on `runs` and made this check
 * always RED on team mode. Fixed 2026-05-09 during the manual
 * end-to-end verification of Phase 4.)
 *
 * Skipped in solo mode (no cloud) and when cloud is unreachable
 * (check 24 covers that case).
 *
 * Thresholds:
 *   - lag < 30s → green (within hot-path sync window)
 *   - lag < 5min → yellow (catchup poll covering)
 *   - lag ≥ 5min → red (sync wedged)
 */
export const syncLagCheck: Check = {
  id: 26,
  name: 'sync lag (Module 04a sync-daemon)',
  severity: 'green-or-yellow',
  async run(ctx) {
    if (ctx.env.COODRA_MODE !== 'team') {
      return { status: 'skipped', detail: 'COODRA_MODE != team' };
    }
    const databaseUrl = ctx.env.DATABASE_URL;
    if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
      return { status: 'skipped', detail: 'DATABASE_URL not set' };
    }
    try {
      await access(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'data.db missing — check 3 covers this' };
    }

    let local: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      local = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return { status: 'skipped', detail: `cannot open ${ctx.dataDb}: ${(err as Error).message}` };
    }

    let cloud: ReturnType<typeof createPostgresDb> | null = null;
    try {
      try {
        cloud = createPostgresDb({ databaseUrl });
      } catch (err) {
        return { status: 'skipped', detail: `cloud connect failed (check 24): ${(err as Error).message}` };
      }

      // SQLite schema stores `runs.started_at` as integer Unix seconds
      // (drizzle `integer({ mode: 'timestamp' })`).
      const localNewestRow = local.raw.prepare(`SELECT MAX(started_at) AS s FROM runs`).get() as
        | { s: number | null }
        | undefined;
      const localNewest = localNewestRow?.s ?? null;

      let cloudNewest: number | null = null;
      try {
        // postgres-js returns plain `timestamp` columns as Date objects,
        // but a value wrapped in an aggregate (`MAX(started_at)`) loses
        // the type-oid mapping and comes back as an ISO string. Coerce
        // through `new Date(...)` so both shapes work — the pre-fix code
        // called `.getTime()` directly and crashed with
        // "rows[0].s.getTime is not a function" on the string path.
        const rows = await cloud.raw<Array<{ s: Date | string | null }>>`SELECT MAX(started_at) AS s FROM runs`;
        const rawS = rows[0]?.s;
        if (rawS != null) {
          const asDate = rawS instanceof Date ? rawS : new Date(rawS);
          cloudNewest = Number.isNaN(asDate.getTime()) ? null : Math.floor(asDate.getTime() / 1000);
        }
      } catch (err) {
        return { status: 'skipped', detail: `cloud query failed: ${(err as Error).message}` };
      }

      if (localNewest === null) {
        return { status: 'green', detail: 'no local runs yet — nothing to lag on' };
      }
      const cloudOrZero = cloudNewest ?? 0;
      const lagSec = Math.max(0, localNewest - cloudOrZero);

      if (cloudNewest === null && localNewest !== null) {
        // No cloud rows at all yet. The naive lag math here would be
        // (localNewest - 0) which is "decades behind" — meaningless.
        // Treat empty cloud as YELLOW with a useful remediation
        // distinguishing two real scenarios:
        //   1. Fresh team setup: local has solo-mode history that
        //      hasn't been migrated yet → run `team migrate`.
        //   2. Sync hasn't run yet: a `coodra start` will begin
        //      draining the outbox.
        return {
          status: 'yellow',
          detail: 'cloud has no runs rows yet; local has historical data',
          remediation:
            'Two paths: (a) if this is your first team-mode session and local has solo data, run ' +
            '`coodra team migrate` to push it up; (b) if you just ran `team setup` and have not yet ' +
            'started services, run `coodra start` to launch the sync-daemon — new writes will flow ' +
            'within ~10s. This check will re-run green on the next `coodra doctor` once cloud has rows.',
        };
      }

      if (lagSec < 30)
        return { status: 'green', detail: `cloud is ${formatLag(lagSec)} behind local — within hot-path window` };
      if (lagSec < 5 * 60) {
        return {
          status: 'yellow',
          detail: `cloud is ${formatLag(lagSec)} behind local`,
          remediation: 'Catchup poll should reduce this; if it persists check sync-daemon logs.',
        };
      }
      return {
        status: 'red',
        detail: `cloud is ${formatLag(lagSec)} behind local — sync wedged`,
        remediation:
          'Sync has fallen significantly behind. Check check 25 (queue depth) and check 27 (dead-letter). ' +
          'Restart the sync-daemon if needed.',
      };
    } finally {
      try {
        local.close();
      } catch {
        // ignore
      }
      try {
        await cloud?.close();
      } catch {
        // ignore
      }
    }
  },
};

function formatLag(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  return `${hours}h${minutes}m`;
}
