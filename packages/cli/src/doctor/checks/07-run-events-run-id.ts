import { access } from 'node:fs/promises';
import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

export const runEventsRunIdCheck: Check = {
  id: 7,
  name: 'run_events.run_id NOT NULL when session has runs row (F8 invariant)',
  severity: 'red',
  async run(ctx) {
    try {
      await access(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'data.db missing' };
    }
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch {
      return { status: 'skipped', detail: 'cannot open data.db' };
    }
    try {
      // F8 invariant: every run_events row should carry a non-NULL run_id once the
      // F8 fix (commit 900e55c) is live. This check counts orphans in the last
      // 24h (created_at is unix-seconds, hence the integer cutoff).
      const cutoff = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      const totals = handle.raw
        .prepare(
          `SELECT
             SUM(CASE WHEN run_id IS NULL THEN 1 ELSE 0 END) AS orphans,
             COUNT(*) AS total
           FROM run_events WHERE created_at >= ?`,
        )
        .get(cutoff) as { orphans: number | null; total: number } | undefined;
      const orphanCount = totals?.orphans ?? 0;
      const total = totals?.total ?? 0;
      if (total === 0) {
        return { status: 'green', detail: 'no run_events in last 24h (nothing to validate)' };
      }
      if (orphanCount === 0) {
        return { status: 'green', detail: `${total} run_events in last 24h, all carry run_id` };
      }
      return {
        status: 'red',
        detail: `${orphanCount}/${total} run_events rows in last 24h have NULL run_id`,
        remediation:
          'F8 closure (commit 900e55c) plumbs runId on every write. ' +
          'A non-zero orphan count means an agent/mcp-server is running a pre-F8 binary or the project resolver is not finding the project. ' +
          'The runs↔run_events join (foundational NHI query) is broken for these rows.',
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('no such table')) {
        return { status: 'skipped', detail: 'run_events table missing — migrations not applied' };
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
