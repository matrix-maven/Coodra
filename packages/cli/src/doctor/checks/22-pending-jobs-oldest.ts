import { access } from 'node:fs/promises';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 03.1 doctor surface — oldest pending row age.
 *
 * Reads `min(created_at) WHERE status='pending'` and computes the
 * delta from now. A row that's been pending for several minutes
 * means the worker isn't draining — either it's stuck on the row
 * itself (the dispatcher is failing in a way that doesn't trip the
 * dead-letter — e.g. a transient_failure that retries forever
 * because each retry resets the cycle) or no worker is running.
 *
 * Thresholds:
 *   - no rows OR oldest ≤ 30s   → green (normal in-flight traffic)
 *   - oldest 30s – 5 min        → yellow (queue building up)
 *   - oldest > 5 min            → red (worker stuck or absent)
 */
export const pendingJobsOldestCheck: Check = {
  id: 22,
  name: 'pending_jobs oldest row age (Module 03.1 outbox)',
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
      const row = handle.raw
        .prepare(`SELECT min(created_at) AS oldest FROM pending_jobs WHERE status = 'pending'`)
        .get() as { oldest: number | null } | undefined;
      const oldestSec = row?.oldest ?? null;
      if (oldestSec === null) {
        return { status: 'green', detail: 'pending_jobs is empty' };
      }
      const nowSec = Math.floor(ctx.now().getTime() / 1000);
      const ageSec = Math.max(0, nowSec - oldestSec);
      if (ageSec <= 30) {
        return { status: 'green', detail: `oldest pending row is ${ageSec}s old (in-flight)` };
      }
      if (ageSec <= 5 * 60) {
        return {
          status: 'yellow',
          detail: `oldest pending row is ${formatAge(ageSec)} old`,
          remediation:
            'Worker draining slowly. Inspect `<coodra-home>/logs/{hooks-bridge,mcp-server}.log` for `outbox_dispatch_*` outcomes. ' +
            'A repeated transient_failure on the same row will eventually mark it dead via `maxAttempts`.',
        };
      }
      return {
        status: 'red',
        detail: `oldest pending row is ${formatAge(ageSec)} old — worker stuck or absent`,
        remediation:
          'No drain is happening. Run `coodra status` to confirm both daemons are alive. ' +
          'Restart with `coodra stop && coodra start`; lease expiry (30s) lets the next worker reclaim leased-but-stuck rows.',
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
