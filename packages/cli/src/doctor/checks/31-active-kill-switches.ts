import { existsSync } from 'node:fs';

import { listAllActiveKillSwitches } from '@coodra/contextos-db';

import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Module 08b S18 check 31 — active kill switch count.
 *
 * YELLOW when count > 0 (pause is intentional — operator should know
 * the bridge is denying / soft-allowing real events). RED only when
 * the DB read fails. Reports the age of the oldest active switch so
 * the operator can spot an "I forgot to resume after the demo" case.
 */
export const activeKillSwitchesCheck: Check = {
  id: 31,
  name: 'No active kill switches (M08b)',
  severity: 'green-or-yellow',
  async run(ctx) {
    // Pre-init machines have no data.db — check 3 already reports
    // that gap as RED. Skipping here keeps the M08b check from
    // duplicating the same red.
    if (!existsSync(ctx.dataDb)) {
      return { status: 'skipped', detail: 'data.db not present yet (covered by check 3)' };
    }
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      return {
        status: 'red',
        detail: `cannot open data.db: ${err instanceof Error ? err.message : String(err)}`,
        remediation: 'Run `contextos doctor` again after `contextos start` to ensure the SQLite store is reachable.',
      };
    }
    try {
      let active: Awaited<ReturnType<typeof listAllActiveKillSwitches>>;
      try {
        active = await listAllActiveKillSwitches(handle, { now: ctx.now() });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Pre-migration data.db (check 3 lazy-created the file but
        // check 4 hasn't applied 0007 yet). Skip — the missing-table
        // state is already RED on check 4.
        if (/no such table:.*kill_switches/i.test(message)) {
          return { status: 'skipped', detail: 'kill_switches table missing (covered by check 4)' };
        }
        throw err;
      }
      if (active.length === 0) {
        return { status: 'green', detail: 'no active kill switches' };
      }
      const oldest = active.reduce<number>(
        (min, s) => (s.pausedAt.getTime() < min ? s.pausedAt.getTime() : min),
        Number.POSITIVE_INFINITY,
      );
      const ageMs = ctx.now().getTime() - oldest;
      const ageMin = Math.round(ageMs / 60_000);
      return {
        status: 'yellow',
        detail: `${active.length} active kill switch(es); oldest paused ${ageMin} min ago`,
        remediation: `Run \`contextos resume --all\` to clear, or \`contextos pause\` (with no args, to see current state via the duplicate-active warning).`,
      };
    } finally {
      handle.close();
    }
  },
};
