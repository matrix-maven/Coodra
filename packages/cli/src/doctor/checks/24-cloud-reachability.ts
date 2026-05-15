import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createPostgresDb } from '@coodra/db';

import type { Check } from '../types.js';

/**
 * Module 04a doctor surface — cloud Postgres reachability.
 *
 * Skipped when `COODRA_MODE !== 'team'` or `DATABASE_URL` is not set
 * (solo mode has no cloud target).
 *
 * Time-based escalation (per OQ3 sign-off 2026-04-28). Doctor runs are
 * one-shot, so we track first-failure time in a small state file at
 * `<coodra-home>/state/sync-cloud-unreachable-since` so successive
 * doctor invocations can compute the elapsed window:
 *   - reachable → green; remove the state file
 *   - unreachable, first time / <5min → yellow (transient)
 *   - unreachable >5min and ≤1h → yellow (persistent — page on-call soon)
 *   - unreachable >1h → red
 *
 * The state file holds an ISO timestamp. Removal on success is the
 * recovery path.
 */
export const cloudReachabilityCheck: Check = {
  id: 24,
  name: 'cloud Postgres reachability (Module 04a sync-daemon)',
  severity: 'green-or-yellow',
  async run(ctx) {
    if (ctx.env.COODRA_MODE !== 'team') {
      return { status: 'skipped', detail: 'COODRA_MODE != team — no cloud target to reach' };
    }
    const databaseUrl = ctx.env.DATABASE_URL;
    if (typeof databaseUrl !== 'string' || databaseUrl.length === 0) {
      return {
        status: 'red',
        detail: 'COODRA_MODE=team but DATABASE_URL is not set',
        remediation:
          'Set DATABASE_URL in your environment (or `<coodra-home>/.env`). The sync-daemon will not start without it.',
      };
    }

    const stateFile = join(ctx.coodraHome, 'state', 'sync-cloud-unreachable-since');
    const reachable = await tryPing(databaseUrl, ctx.timeoutMs);

    if (reachable.ok) {
      await safeRemove(stateFile);
      return { status: 'green', detail: 'cloud Postgres reachable (SELECT 1 returned 1)' };
    }

    // Unreachable. Track first-failure time.
    const sinceMs = await readSince(stateFile);
    if (sinceMs === null) {
      await writeSince(stateFile, ctx.now());
      return {
        status: 'yellow',
        detail: `cloud Postgres unreachable: ${reachable.err}`,
        remediation: 'First failure recorded. Re-run doctor in 5 minutes to confirm whether the outage persists.',
      };
    }
    const elapsedMs = ctx.now().getTime() - sinceMs;
    const elapsedMin = Math.floor(elapsedMs / 60_000);
    if (elapsedMs > 60 * 60 * 1000) {
      return {
        status: 'red',
        detail: `cloud Postgres unreachable for >${elapsedMin}min: ${reachable.err}`,
        remediation:
          'Cloud sync has been broken for over 1 hour. Inspect DATABASE_URL credentials and network reachability, ' +
          'check the cloud Postgres provider status page, and verify firewall rules. Audit rows continue to land ' +
          'in local SQLite (offline-first); they will drain to cloud on reconnect.',
      };
    }
    return {
      status: 'yellow',
      detail: `cloud Postgres unreachable for ${elapsedMin}min: ${reachable.err}`,
      remediation:
        'Transient cloud outage. Audit rows continue to land in local SQLite. The check escalates to RED after 1 hour.',
    };
  },
};

async function tryPing(databaseUrl: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; err: string }> {
  let handle: ReturnType<typeof createPostgresDb>;
  try {
    handle = createPostgresDb({ databaseUrl });
  } catch (err) {
    return { ok: false, err: (err as Error).message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await handle.raw`SELECT 1`;
    return { ok: true };
  } catch (err) {
    return { ok: false, err: (err as Error).message };
  } finally {
    clearTimeout(timer);
    try {
      await handle.close();
    } catch {
      // ignore close errors
    }
  }
}

async function readSince(stateFile: string): Promise<number | null> {
  try {
    const raw = await readFile(stateFile, 'utf8');
    const parsed = Date.parse(raw.trim());
    if (Number.isNaN(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeSince(stateFile: string, when: Date): Promise<void> {
  try {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(stateFile, when.toISOString(), 'utf8');
  } catch {
    // Cannot write state — the next doctor run will treat the failure as
    // first-time and escalate later than ideal. Not worth a separate alert.
  }
}

async function safeRemove(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore — file may not exist
  }
}
