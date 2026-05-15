import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { type DbHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';

import { createBridgeDispatchHandler } from '../../../src/lib/outbox-dispatch.js';

/**
 * Test helper: drain `pending_jobs` to its destination tables by
 * ticking an OutboxWorker until either the queue is empty or a
 * safety bound is reached. Mirrors the production worker's
 * dispatch logic exactly (constructs the same dispatch handler the
 * boot path will use in S3) so tests verify the durable path
 * end-to-end, not a test-only shortcut.
 *
 * Two-pass design. The bridge enqueues `session_open` and
 * `policy_decision` (or `run_event`) for the same SessionStart →
 * PreToolUse flow; the policy_decision payload uses
 * `session_lookup` for runId resolution, which only succeeds AFTER
 * session_open has dispatched to `runs`. A single tick may dispatch
 * the policy_decision before session_open. This helper ticks
 * repeatedly so dependencies resolve in any order — caller doesn't
 * need to think about ordering.
 *
 * Lease-aware. We construct a fresh worker each call with a short
 * lease (1s) to keep tests fast. Production workers use the
 * default 30s.
 */

const MAX_TICKS = 50;

export async function drainOutbox(handle: DbHandle): Promise<void> {
  const worker = new OutboxWorker({
    db: handle,
    dispatchHandler: createBridgeDispatchHandler({ db: handle }),
    tickMs: 60_000,
    leaseMs: 1_000,
  });
  for (let i = 0; i < MAX_TICKS; i += 1) {
    await worker.tick();
    const remaining = await pendingCount(handle);
    if (remaining === 0) break;
  }
  await worker.stop();
}

async function pendingCount(handle: DbHandle): Promise<number> {
  if (handle.kind !== 'sqlite') return 0;
  const rows = await handle.db
    .select({ id: sqliteSchema.pendingJobs.id })
    .from(sqliteSchema.pendingJobs)
    .where(eq(sqliteSchema.pendingJobs.status, 'pending'));
  return rows.length;
}
