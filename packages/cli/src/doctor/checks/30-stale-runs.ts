import { openLocalDb } from '../../lib/open-local-db.js';
import type { Check } from '../types.js';

/**
 * Slice 5 (2026-05-03 audit §14.1 + §14.3) — stale `in_progress` runs
 * warning. Pre-Slice-2 + Slice-8, every Claude Code session whose
 * SessionEnd hook didn't fire left its `runs` row stuck
 * `status='in_progress'` forever. The audit observed 6 such orphans
 * in the demo DB.
 *
 * Slice 2 closes the SessionEnd registration gap (no more new
 * orphans). Slice 8 adds SessionStart-time cleanup that flips prior
 * orphans to `status='abandoned'` when a new session opens.
 *
 * This check surfaces the long-tail case: runs that have been
 * `in_progress` for more than 24 hours AND no new session has
 * triggered the Slice 8 cleanup. Threshold is set generously so
 * legitimate long sessions (overnight refactors) don't trip the
 * warning.
 *
 * Read-only — never mutates the runs table. Yellow if any orphans
 * exist; the remediation is "open and close a Claude Code session
 * in any of the affected projects" so Slice 8's gate fires.
 */

const STALE_THRESHOLD_HOURS = 24;

export const staleRunsCheck: Check = {
  id: 30,
  name: 'in_progress runs older than 24h have not been cleaned up',
  severity: 'yellow',
  async run(ctx) {
    let handle: Awaited<ReturnType<typeof openLocalDb>>;
    try {
      handle = await openLocalDb(ctx.dataDb);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'SQLITE_CANTOPEN') {
        return {
          status: 'yellow',
          detail: `${ctx.dataDb} not found — run \`contextos init\` first.`,
        };
      }
      return { status: 'yellow', detail: `cannot open ${ctx.dataDb}: ${(err as Error).message}` };
    }

    try {
      const cutoffSec = Math.floor(ctx.now().getTime() / 1000) - STALE_THRESHOLD_HOURS * 3600;
      let count: number;
      try {
        const row = handle.raw
          .prepare(`SELECT COUNT(*) AS count FROM runs WHERE status = 'in_progress' AND started_at < ?`)
          .get(cutoffSec) as { count: number } | undefined;
        count = row?.count ?? 0;
      } catch (err) {
        // Migrations not applied yet (no `runs` table) or row format
        // drift — surface as yellow rather than letting the error bubble
        // up and turn into a generic red. Keeps the JSON output clean
        // and gives the user an actionable next step.
        return {
          status: 'yellow',
          detail: `cannot read runs table: ${(err as Error).message}`,
          remediation: 'Run `contextos init` to apply migrations and seed the schema.',
        };
      }
      if (count === 0) {
        return {
          status: 'green',
          detail: `no in_progress runs older than ${STALE_THRESHOLD_HOURS}h.`,
        };
      }
      return {
        status: 'yellow',
        detail: `${count} in_progress run(s) older than ${STALE_THRESHOLD_HOURS}h - likely orphaned (SessionEnd never fired or the session crashed).`,
        remediation:
          'Open a new Claude Code session in any affected project so Slice 8 (Phase 4 Fix J) marks prior in_progress runs as abandoned at SessionStart.',
      };
    } finally {
      handle.close();
    }
  },
};
