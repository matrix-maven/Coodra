import { sqliteSchema } from '@coodra/contextos-db';
import { and, desc, eq, sql } from 'drizzle-orm';

import { createWebDb } from '@/lib/db';

/**
 * `apps/web/lib/queries/sync.ts` — server-only aggregation over the
 * `pending_jobs` table for the M04 Phase 2 S15 sync surface.
 *
 * Two read shapes:
 *
 *   - `aggregatePendingJobs()` — group by (queue, status) → counts.
 *     Powers the queue-depth tiles + dead-letter tile.
 *   - `listDeadLetterJobs(queue, limit)` — full rows for the
 *     dead-letter table (last-error, created_at).
 *
 * Today the implementation is sqlite-only because the web app's
 * createWebDb adapter is sqlite in solo mode and (per ADR-008) the
 * outbox table lives on the local store. Team-mode pages need to
 * either route through the cloud DB or read from the cloud's own
 * pending_jobs mirror — which lands with M04a's sync-daemon
 * surfaces. For now, team mode renders the empty-state explainer.
 */

export interface QueueDepthRow {
  readonly queue: string;
  readonly pending: number;
  readonly picked: number;
  readonly dead: number;
}

export interface DeadJobRow {
  readonly id: string;
  readonly queue: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly failedAt: Date | null;
  readonly createdAt: Date;
}

export interface SyncSnapshot {
  readonly mode: 'solo' | 'team';
  readonly queues: ReadonlyArray<QueueDepthRow>;
  readonly recentDead: ReadonlyArray<DeadJobRow>;
  readonly fetchedAt: string;
}

export async function fetchSyncSnapshot(): Promise<SyncSnapshot> {
  const mode = (process.env.CONTEXTOS_MODE === 'team' ? 'team' : 'solo') as 'solo' | 'team';
  const db = createWebDb();
  if (db.kind !== 'sqlite') {
    return { mode, queues: [], recentDead: [], fetchedAt: new Date().toISOString() };
  }
  const t = sqliteSchema.pendingJobs;
  // Group by (queue, status) → count. Drizzle's count + group_by isn't
  // directly typed on every helper version so use raw SQL via the
  // db.raw handle.
  const rawRows = db.raw
    .prepare('SELECT queue, status, COUNT(*) as n FROM pending_jobs GROUP BY queue, status ORDER BY queue, status')
    .all() as ReadonlyArray<{ queue: string; status: string; n: number }>;

  const byQueue = new Map<string, QueueDepthRow>();
  for (const r of rawRows) {
    const cur = byQueue.get(r.queue) ?? { queue: r.queue, pending: 0, picked: 0, dead: 0 };
    if (r.status === 'pending') byQueue.set(r.queue, { ...cur, pending: r.n });
    else if (r.status === 'picked') byQueue.set(r.queue, { ...cur, picked: r.n });
    else if (r.status === 'dead') byQueue.set(r.queue, { ...cur, dead: r.n });
    else byQueue.set(r.queue, cur);
  }
  const queues = [...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue));

  const recentDeadRaw = await db.db.select().from(t).where(eq(t.status, 'dead')).orderBy(desc(t.failedAt)).limit(20);
  const recentDead: DeadJobRow[] = recentDeadRaw.map((r) => ({
    id: r.id,
    queue: r.queue,
    attempts: r.attempts,
    lastError: r.lastError,
    failedAt: r.failedAt,
    createdAt: r.createdAt,
  }));

  return { mode, queues, recentDead, fetchedAt: new Date().toISOString() };
}

/**
 * Marks a dead job as `pending` again (resets attempts to 0). The
 * sync-daemon will pick it up on the next poll. Returns the number of
 * rows actually flipped (0 if the job no longer exists or wasn't
 * dead).
 */
export async function retryDeadJob(jobId: string): Promise<number> {
  const db = createWebDb();
  if (db.kind !== 'sqlite') return 0;
  const t = sqliteSchema.pendingJobs;
  const result = (await db.db
    .update(t)
    .set({ status: 'pending', attempts: 0, failedAt: null, lastError: null, runAfter: new Date() })
    .where(and(eq(t.id, jobId), eq(t.status, 'dead')))) as { changes?: number };
  return result.changes ?? 0;
}

/**
 * Bulk-retry every dead job in a queue. Returns the count of flipped
 * rows. Caller should refresh the page after.
 */
export async function retryAllDeadJobs(queue: string): Promise<number> {
  const db = createWebDb();
  if (db.kind !== 'sqlite') return 0;
  const t = sqliteSchema.pendingJobs;
  const result = (await db.db
    .update(t)
    .set({ status: 'pending', attempts: 0, failedAt: null, lastError: null, runAfter: new Date() })
    .where(and(eq(t.queue, queue), eq(t.status, 'dead')))) as { changes?: number };
  return result.changes ?? 0;
}

void sql; // re-export anchor — keep the drizzle helper imported for future raw queries.
