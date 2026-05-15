import { access } from 'node:fs/promises';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 04a doctor surface — sync_to_cloud queue depth.
 *
 * Same shape as M03.1 check 21 (audit-write queue depth) but filters
 * to `queue='sync_to_cloud'`. Skipped in solo mode (no daemon).
 *
 * Thresholds (OQ3 alignment):
 *   - depth ≤ 10  → green (normal active sync flow)
 *   - depth ≤ 100 → yellow (daemon may be slow or cloud transiently down)
 *   - depth > 100 → red (daemon stuck, absent, or cloud down for >1min)
 */
export const syncQueueDepthCheck: Check = {
  id: 25,
  name: 'sync_to_cloud queue depth (Module 04a sync-daemon)',
  severity: 'green-or-yellow',
  async run(ctx) {
    if (ctx.env.COODRA_MODE !== 'team') {
      return { status: 'skipped', detail: 'COODRA_MODE != team — no sync queue in solo' };
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
      const row = handle.raw
        .prepare(`SELECT COUNT(*) AS n FROM pending_jobs WHERE status='pending' AND queue='sync_to_cloud'`)
        .get() as { n: number } | undefined;
      const depth = row?.n ?? 0;
      if (depth === 0) return { status: 'green', detail: 'sync_to_cloud queue is empty' };
      if (depth <= 10) return { status: 'green', detail: `${depth} sync row(s) — normal active flow` };
      if (depth <= 100) {
        return {
          status: 'yellow',
          detail: `${depth} sync row(s) — building up`,
          remediation:
            'Sync-daemon may be slow or cloud transiently unreachable. Run `coodra status` to confirm sync-daemon is running. ' +
            'Inspect `<coodra-home>/logs/sync-daemon.log` for `sync_dispatch_*` lines.',
        };
      }
      return {
        status: 'red',
        detail: `${depth} sync row(s) — daemon stuck or cloud down`,
        remediation:
          'Sync queue is not draining. Check check 24 (cloud reachability) for upstream cause. ' +
          'If cloud is up, restart the daemon (`coodra stop && coodra start`) to reclaim leased rows.',
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
