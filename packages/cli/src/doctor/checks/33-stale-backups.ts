import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Check } from '../types.js';

/**
 * Module 08b S18 check 33 — stale `~/.contextos/backups/*.bak.*` files.
 *
 * YELLOW when any backup file is older than 30 days. Reports total
 * size so the operator can decide whether to manually clean.
 * GREEN when the backups dir is empty or all files are < 30 days old.
 *
 * Pure observability — never deletes anything itself. Operator
 * runs `rm` when ready.
 */
export const staleBackupsCheck: Check = {
  id: 33,
  name: 'No stale backups under ~/.contextos/backups/ (>30d) (M08b)',
  severity: 'green-or-yellow',
  async run(ctx) {
    const backupsDir = join(ctx.contextosHome, 'backups');
    if (!existsSync(backupsDir)) {
      return { status: 'green', detail: 'no backups directory yet' };
    }
    const cutoff = ctx.now().getTime() - 30 * 24 * 60 * 60 * 1000;
    let staleCount = 0;
    let totalStaleBytes = 0;
    let oldestMtime = Number.POSITIVE_INFINITY;
    let entries: string[];
    try {
      entries = readdirSync(backupsDir);
    } catch (err) {
      return {
        status: 'red',
        detail: `cannot read ${backupsDir}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    for (const name of entries) {
      try {
        const s = statSync(join(backupsDir, name));
        if (!s.isFile()) continue;
        if (s.mtimeMs < cutoff) {
          staleCount += 1;
          totalStaleBytes += s.size;
          if (s.mtimeMs < oldestMtime) oldestMtime = s.mtimeMs;
        }
      } catch {
        // skip unstattable
      }
    }
    if (staleCount === 0) {
      return { status: 'green', detail: 'no backup files older than 30 days' };
    }
    const oldestAgeDays = Math.floor((ctx.now().getTime() - oldestMtime) / (24 * 60 * 60 * 1000));
    return {
      status: 'yellow',
      detail: `${staleCount} stale backup(s) (oldest ${oldestAgeDays} days; total ${humanBytes(totalStaleBytes)})`,
      remediation: `Run \`ls -lh ${backupsDir}/\` to inspect and \`rm\` to clean up. Operator hygiene only — backups are never auto-deleted.`,
    };
  },
};

function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
