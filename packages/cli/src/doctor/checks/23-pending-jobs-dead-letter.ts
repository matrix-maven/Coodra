import { access } from 'node:fs/promises';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 03.1 doctor surface — dead-letter count.
 *
 * Counts rows the OutboxWorker has marked `status='dead'` after
 * exhausting retries (or hitting a permanent_failure). Thresholds
 * locked at OQ3 sign-off (2026-04-27):
 *
 *   - 0 dead                        → green (clean)
 *   - 1–10 dead                     → yellow with remediation
 *   - >10 dead OR any dead row >1h  → red
 *
 * The "any dead row older than 1h" escalation makes a small
 * accumulation that's been ignored for an hour bubble up to RED
 * even when the count is below the 10-row ceiling.
 */
export const pendingJobsDeadLetterCheck: Check = {
  id: 23,
  name: 'pending_jobs dead-letter count (Module 03.1 outbox)',
  severity: 'green-or-yellow',
  async run(ctx) {
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
        .prepare(`SELECT COUNT(*) AS n, MIN(failed_at) AS oldest_failed_at FROM pending_jobs WHERE status = 'dead'`)
        .get() as { n: number; oldest_failed_at: number | null } | undefined;
      const dead = summary?.n ?? 0;
      const oldestFailedSec = summary?.oldest_failed_at ?? null;

      if (dead === 0) {
        return { status: 'green', detail: 'no dead rows in pending_jobs' };
      }

      const nowSec = Math.floor(ctx.now().getTime() / 1000);
      const oldestAgeSec = oldestFailedSec === null ? 0 : Math.max(0, nowSec - oldestFailedSec);
      const oldestAgeIsRed = oldestAgeSec > 60 * 60; // > 1 hour

      if (dead > 10 || oldestAgeIsRed) {
        const reason =
          dead > 10 ? `${dead} dead rows (>10 ceiling)` : `dead row older than 1h (oldest ${formatAge(oldestAgeSec)})`;
        return {
          status: 'red',
          detail: `dead-letter escalated to RED: ${reason}`,
          remediation:
            'Inspect dead rows: `sqlite3 <coodra-home>/data.db "SELECT id, queue, attempts, last_error FROM pending_jobs WHERE status=\'dead\'"`. ' +
            'Each dead row carries `last_error` from the final attempt — common causes: payload schema drift (programming bug), FK pointing at a deleted runs row. ' +
            "Manual remediation: fix the root cause, then `DELETE FROM pending_jobs WHERE status='dead'`. " +
            'A single dead row older than 1h triggers RED to flag accumulating dead-letters that were ignored.',
        };
      }

      // 1–10 dead, none older than 1h.
      return {
        status: 'yellow',
        detail: `${dead} dead row(s) (oldest ${formatAge(oldestAgeSec)})`,
        remediation:
          'Inspect with: `sqlite3 <coodra-home>/data.db "SELECT id, queue, attempts, last_error FROM pending_jobs WHERE status=\'dead\'"`. ' +
          'Each row carries `last_error` from its final attempt. ' +
          'The dead-letter check escalates to RED when count > 10 OR any row is older than 1h.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return {
          status: 'skipped',
          detail: '`pending_jobs` table missing — migrations not applied',
        };
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

function formatAge(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m${ageSec % 60}s`;
  const hours = Math.floor(ageSec / 3600);
  const minutes = Math.floor((ageSec % 3600) / 60);
  return `${hours}h${minutes}m`;
}
