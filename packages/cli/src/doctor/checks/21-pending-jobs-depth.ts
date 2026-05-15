import { access } from 'node:fs/promises';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 03.1 doctor surface — pending_jobs queue depth.
 *
 * Counts `pending_jobs WHERE status='pending'`. A nonzero count is
 * normal during active hook traffic — the OutboxWorker drains on
 * 1-second tick. A growing queue means the worker is stuck (DB
 * timeout, dispatcher throwing every tick, or no worker process is
 * running at all).
 *
 * Thresholds:
 *   - depth ≤ 10  → green (normal flow)
 *   - depth ≤ 100 → yellow (queue building up; worker may be slow)
 *   - depth > 100 → red (worker stuck or absent)
 */
export const pendingJobsDepthCheck: Check = {
  id: 21,
  name: 'pending_jobs queue depth (Module 03.1 outbox)',
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
      const row = handle.raw.prepare(`SELECT COUNT(*) AS n FROM pending_jobs WHERE status = 'pending'`).get() as
        | { n: number }
        | undefined;
      const depth = row?.n ?? 0;
      if (depth === 0) {
        return { status: 'green', detail: 'pending_jobs is empty' };
      }
      if (depth <= 10) {
        return { status: 'green', detail: `${depth} row(s) pending — normal active queue` };
      }
      if (depth <= 100) {
        return {
          status: 'yellow',
          detail: `${depth} pending row(s) — queue is building up`,
          remediation:
            'OutboxWorker may be slow. Check `<coodra-home>/logs/{hooks-bridge,mcp-server}.log` for `outbox_dispatch_*` lines. ' +
            'If the worker is wedged on a single row, restarting the daemons (`coodra stop && coodra start`) reclaims it via the lease.',
        };
      }
      return {
        status: 'red',
        detail: `${depth} pending row(s) — worker is stuck or absent`,
        remediation:
          'OutboxWorker is not draining. Run `coodra status` to confirm both daemons are running. ' +
          'Inspect logs for `outbox_dispatch_failed` or `outbox_claim_failed`. Restart with ' +
          '`coodra stop && coodra start` to reclaim leased rows.',
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
