import { access } from 'node:fs/promises';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 04a doctor surface — sync_to_cloud dead-letter count.
 *
 * Same OQ3 thresholds as M03.1 check 23 (audit dead-letter), filtered
 * to `queue='sync_to_cloud'`. Skipped in solo mode.
 *
 *   - 0 dead                        → green
 *   - 1–10 dead                     → yellow
 *   - >10 dead OR any dead row >1h  → red
 */
export const syncDeadLetterCheck: Check = {
  id: 27,
  name: 'sync_to_cloud dead-letter count (Module 04a sync-daemon)',
  severity: 'green-or-yellow',
  async run(ctx) {
    if (ctx.env.COODRA_MODE !== 'team') {
      return { status: 'skipped', detail: 'COODRA_MODE != team' };
    }
    try {
      await access(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'data.db missing — check 3 covers this' };
    }
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return { status: 'skipped', detail: `cannot open ${ctx.dataDb}: ${(err as Error).message}` };
    }
    try {
      const summary = handle.raw
        .prepare(
          `SELECT COUNT(*) AS n, MIN(failed_at) AS oldest_failed_at FROM pending_jobs WHERE status='dead' AND queue='sync_to_cloud'`,
        )
        .get() as { n: number; oldest_failed_at: number | null } | undefined;
      const dead = summary?.n ?? 0;
      const oldestFailedSec = summary?.oldest_failed_at ?? null;

      if (dead === 0) return { status: 'green', detail: 'no dead sync rows' };

      const nowSec = Math.floor(ctx.now().getTime() / 1000);
      const oldestAgeSec = oldestFailedSec === null ? 0 : Math.max(0, nowSec - oldestFailedSec);
      const oldestAgeIsRed = oldestAgeSec > 60 * 60;

      if (dead > 10 || oldestAgeIsRed) {
        const reason = dead > 10 ? `${dead} dead sync rows (>10 ceiling)` : `dead sync row older than 1h`;
        return {
          status: 'red',
          detail: `dead-letter escalated to RED: ${reason}`,
          remediation:
            "Inspect dead sync rows: `sqlite3 <coodra-home>/data.db \"SELECT id, payload, attempts, last_error FROM pending_jobs WHERE status='dead' AND queue='sync_to_cloud'\"`. " +
            'Common causes: schema mismatch (cloud migration not applied — run `coodra cloud-migrate`), ' +
            'cloud Postgres permanently unreachable, FK target missing on cloud (parent runs row never synced). ' +
            "After fixing the root cause: `DELETE FROM pending_jobs WHERE status='dead' AND queue='sync_to_cloud'`.",
        };
      }
      return {
        status: 'yellow',
        detail: `${dead} dead sync row(s)`,
        remediation:
          "Inspect with: `sqlite3 <coodra-home>/data.db \"SELECT id, payload, attempts, last_error FROM pending_jobs WHERE status='dead' AND queue='sync_to_cloud'\"`. " +
          'Escalates to RED at >10 OR any row older than 1h.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return { status: 'skipped', detail: '`pending_jobs` table missing — migrations not applied' };
      }
      return { status: 'red', detail: msg };
    } finally {
      try {
        handle.close();
      } catch {
        // ignore
      }
    }
  },
};
