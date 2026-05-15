import { OutboxWorker } from '@coodra/cli/lib/outbox';
import { type DbHandle, sqliteSchema } from '@coodra/db';
import { eq } from 'drizzle-orm';

import { createMcpDispatchHandler } from '../../../src/lib/outbox-dispatch.js';

/**
 * Test helper: drain `pending_jobs` to its destination tables by
 * ticking an OutboxWorker until either the queue is empty or a
 * safety bound is reached. Mirrors the production worker's
 * dispatch logic (constructs the same dispatch handler the boot
 * path will use in S3) so tests verify the durable path
 * end-to-end, not a test-only shortcut.
 */

const MAX_TICKS = 50;

export async function drainOutbox(handle: DbHandle): Promise<void> {
  const worker = new OutboxWorker({
    db: handle,
    dispatchHandler: createMcpDispatchHandler({ db: handle }),
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
