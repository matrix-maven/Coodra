import { randomUUID } from 'node:crypto';

import { createLogger } from '@coodra/shared';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

/**
 * `packages/db/src/schedule-durable-write` — the entry point for the
 * Module 03.1 durable audit outbox (`docs/feature-packs/03.1-durable-outbox/`).
 *
 * Inserts one row into `pending_jobs` with the canonical envelope. The
 * row is the "pending" record of an audit-write the bridge or
 * mcp-server intends to perform; an `OutboxWorker` (S1) drains the
 * queue and dispatches each row to its destination table
 * (`run_events`, `policy_decisions`, etc.).
 *
 * Crash safety. The big AC for Module 03.1 is: SIGTERM mid-PreToolUse
 * with a queued audit write must result in the row landing AFTER
 * restart, not being lost. That guarantee is the reason this helper
 * exists — instead of `setImmediate(() => insert(...))` (which is lost
 * if the process exits before the callback fires), every audit write
 * goes through one durable INSERT into `pending_jobs` first, then a
 * worker drains it. The drain is restartable; the INSERT is not lost.
 *
 * Caller-controlled dedupe. The caller may pass `id` to control whether
 * a duplicate enqueue is a no-op. When omitted, a fresh UUID is
 * generated. The unique constraint on `pending_jobs.id` plus
 * `ON CONFLICT (id) DO NOTHING` makes the insert idempotent under retry
 * (e.g. an outer caller that retries `scheduleDurableWrite` after a
 * transient `BUSY` from SQLite will see `enqueued: false` on the
 * second attempt — exactly once enqueue, exactly once drain).
 *
 * Payload. Stored as JSON-encoded text in both dialects (parity with
 * `decisions.alternatives` — the JSONB win on Postgres is small here
 * and the schema-parity test treats both as `text`). Caller is
 * responsible for serialising shapes the dispatch handler can read
 * back; the helper only enforces "must be JSON-serializable via
 * `JSON.stringify`."
 *
 * `runAfter` defaults to now (eligible for immediate pickup). The
 * worker's backoff path stamps a future `runAfter` on transient
 * failure (S1).
 */

export interface ScheduleDurableWriteArgs {
  /** Queue name. Routes the job to the right destination handler. */
  readonly queue: string;
  /**
   * The job payload. Must be JSON-serializable. The dispatch handler
   * `JSON.parse()`s this back; if `JSON.stringify` throws here the
   * caller has a programming bug.
   */
  readonly payload: unknown;
  /**
   * Caller-supplied id. When present, a second enqueue with the same
   * id is a no-op (`enqueued: false`). When omitted, a fresh UUID is
   * generated and `enqueued` is always `true` (modulo a UUID collision,
   * which has negligible probability).
   */
  readonly id?: string;
  /**
   * Earliest time the worker may pick this job. Defaults to now. The
   * worker's backoff path stamps a future value on transient failure
   * (see `OutboxWorker` S1).
   */
  readonly runAfter?: Date;
}

export interface ScheduleDurableWriteResult {
  readonly id: string;
  /**
   * `true` when this call inserted a fresh row, `false` when the
   * caller-supplied id collided with an existing row. Callers that
   * don't pass `id` may safely ignore this; it's always `true` for
   * auto-generated ids.
   */
  readonly enqueued: boolean;
}

const log = createLogger('db.schedule-durable-write');

export async function scheduleDurableWrite(
  db: DbHandle,
  args: ScheduleDurableWriteArgs,
): Promise<ScheduleDurableWriteResult> {
  if (typeof args.queue !== 'string' || args.queue === '') {
    throw new TypeError('scheduleDurableWrite: queue is required and must be a non-empty string');
  }

  const id = args.id ?? randomUUID();
  const payload = JSON.stringify(args.payload);
  const runAfter = args.runAfter ?? new Date();

  if (db.kind === 'sqlite') {
    const inserted = await db.db
      .insert(sqliteSchema.pendingJobs)
      .values({
        id,
        queue: args.queue,
        payload,
        runAfter,
      })
      .onConflictDoNothing({ target: sqliteSchema.pendingJobs.id })
      .returning({ id: sqliteSchema.pendingJobs.id });
    const enqueued = inserted.length > 0;
    log.debug({ event: 'durable_write_scheduled', queue: args.queue, jobId: id, enqueued }, 'pending_jobs row state');
    return { id, enqueued };
  }

  const inserted = await db.db
    .insert(postgresSchema.pendingJobs)
    .values({
      id,
      queue: args.queue,
      payload,
      runAfter,
    })
    .onConflictDoNothing({ target: postgresSchema.pendingJobs.id })
    .returning({ id: postgresSchema.pendingJobs.id });
  const enqueued = inserted.length > 0;
  log.debug({ event: 'durable_write_scheduled', queue: args.queue, jobId: id, enqueued }, 'pending_jobs row state');
  return { id, enqueued };
}
