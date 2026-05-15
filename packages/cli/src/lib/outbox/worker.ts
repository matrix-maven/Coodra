import type { DbHandle } from '@coodra/db';
import { createLogger, type Logger } from '@coodra/shared';

import { computeBackoff, MAX_ATTEMPTS_DEFAULT, shouldGiveUp } from './backoff.js';
import type { OutboxDispatchHandler, OutboxDispatchOutcome, OutboxJob } from './types.js';

/**
 * Module 03.1 — `OutboxWorker`. Drains `pending_jobs` to its
 * destination tables (`run_events`, `policy_decisions`, …) via a
 * consumer-supplied `OutboxDispatchHandler`.
 *
 * Lifecycle. `start()` schedules the first tick; subsequent ticks
 * fire on a `setTimeout(tickMs)` chain (not setInterval — chaining
 * lets us guarantee no overlapping ticks). `stop()` cancels the
 * timer and awaits any in-flight dispatch so a graceful SIGTERM
 * can complete the in-flight write before exit. `kick()` schedules
 * an immediate tick and is called from the same code path that
 * just enqueued a row, to keep audit-write latency low under
 * normal operation.
 *
 * Atomic claim. The tick acquires one row by issuing a single
 * `UPDATE … SET status='picked', picked_at=now, attempts=attempts+1
 * WHERE id = (SELECT … LIMIT 1) RETURNING …` statement. SQLite
 * serializes writes at the journal level so two workers connecting
 * to the same DB file can't both win; Postgres uses
 * `FOR UPDATE SKIP LOCKED` on the inner SELECT for the same effect
 * across multiple workers. The same statement also reclaims orphan
 * rows whose `picked_at` is older than `leaseMs` — covering the
 * SIGTERM-mid-dispatch case where a worker pulled a row, started
 * dispatching, and was killed before the destination INSERT
 * landed.
 *
 * Dispatch outcome. `success` → DELETE the row.
 * `transient_failure` AND attempts < maxAttempts → schedule retry
 * with `computeBackoff` and stamp `last_error`.
 * `permanent_failure` OR attempts >= maxAttempts → mark
 * `status='dead'`, stamp `failed_at` and `last_error`. The doctor
 * dead-letter check (S4) reads `status='dead'` rows and surfaces
 * them by count and age.
 *
 * Crash safety. The single guarantee that motivates the entire
 * module: SIGTERM mid-PreToolUse with a queued audit write must
 * result in the row landing AFTER restart, not being lost. This is
 * upheld by:
 *   1. `scheduleDurableWrite` (S0) — caller's write is durable
 *      before the response returns.
 *   2. The worker on restart picks up `status='pending'` rows AND
 *      orphan `status='picked'` rows past their lease.
 *   3. Destination INSERTs are idempotent (e.g. F14
 *      `idempotency_key` on `policy_decisions`) so a re-dispatch
 *      after a partial first dispatch lands at most one row.
 *
 * Concurrency. Internally the worker holds at most one in-flight
 * dispatch (`#inFlight`). A tick that fires while the previous tick
 * is still running becomes a no-op (the post-resolve callback
 * schedules the next tick, so we never over-rate-limit when
 * dispatch is faster than `tickMs`). For multi-process
 * concurrency, the atomic claim is the only correctness mechanism
 * — no app-level locks.
 */
export interface OutboxWorkerDeps {
  readonly db: DbHandle;
  readonly dispatchHandler: OutboxDispatchHandler;
  /** Override the default child logger. */
  readonly logger?: Logger;
  /** Override `Date.now`. Tests inject this to control time. */
  readonly clock?: () => number;
  /** Tick interval (ms). Default: 1000. */
  readonly tickMs?: number;
  /**
   * Lease duration (ms) — how long a `status='picked'` row counts as
   * actively in flight before another worker may reclaim it. Default:
   * 30000. Aligns with the bridge's SIGTERM grace window so a worker
   * killed mid-dispatch doesn't have its row reclaimed before the
   * graceful shutdown finishes.
   */
  readonly leaseMs?: number;
  /** Max attempts before a row is marked dead. Default: 6. */
  readonly maxAttempts?: number;
  /**
   * Restrict which `pending_jobs.queue` values this worker may claim.
   * Module 04a OQ7 constraint: bridge + mcp-server workers pass
   * `AUDIT_QUEUE_KINDS` so they never claim a `sync_to_cloud` row meant
   * for the sync-daemon, and vice versa. Cross-pollination is also
   * caught by a defense-in-depth runtime assertion in `#runOne` that
   * marks any wrongly-leased row dead with a loud error log.
   *
   * When `undefined` the worker claims any row (legacy M03.1 behavior;
   * no longer used in production but kept for tests).
   */
  readonly queueFilter?: ReadonlyArray<string>;
}

const TICK_MS_DEFAULT = 1_000;
const LEASE_MS_DEFAULT = 30_000;

interface ClaimedRow {
  readonly id: string;
  readonly queue: string;
  readonly payload: string;
  readonly attempts: number;
}

export class OutboxWorker {
  readonly #db: DbHandle;
  readonly #dispatchHandler: OutboxDispatchHandler;
  readonly #log: Logger;
  readonly #clock: () => number;
  readonly #tickMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #queueFilter: ReadonlyArray<string> | null;
  readonly #queueFilterSet: ReadonlySet<string> | null;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #stopped = false;

  constructor(deps: OutboxWorkerDeps) {
    this.#db = deps.db;
    this.#dispatchHandler = deps.dispatchHandler;
    this.#log = deps.logger ?? createLogger('cli.outbox-worker');
    this.#clock = deps.clock ?? Date.now;
    this.#tickMs = deps.tickMs ?? TICK_MS_DEFAULT;
    this.#leaseMs = deps.leaseMs ?? LEASE_MS_DEFAULT;
    this.#maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
    if (deps.queueFilter !== undefined) {
      if (deps.queueFilter.length === 0) {
        throw new Error('OutboxWorker: queueFilter must contain at least one queue kind when provided');
      }
      this.#queueFilter = [...deps.queueFilter];
      this.#queueFilterSet = new Set(deps.queueFilter);
    } else {
      this.#queueFilter = null;
      this.#queueFilterSet = null;
    }
  }

  /** Begin the tick chain. Idempotent: a second `start()` is a no-op. */
  start(): void {
    if (this.#stopped) {
      throw new Error('OutboxWorker: cannot start after stop()');
    }
    if (this.#timer !== null || this.#inFlight !== null) return;
    this.#scheduleNext(this.#tickMs);
  }

  /**
   * Stop the tick chain and await any in-flight dispatch. Safe to
   * call multiple times. After `stop()`, `start()` is rejected;
   * construct a fresh worker for a new lifecycle.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }

  /**
   * Schedule an immediate tick. Called from the same code path that
   * just enqueued a row to keep audit-write latency low. Safe to
   * call before `start()` or after `stop()` (no-op in both cases).
   */
  kick(): void {
    if (this.#stopped) return;
    this.#scheduleNext(0);
  }

  /**
   * Run one tick synchronously (for tests). Production code uses
   * `start()` and lets the timer chain drive ticks.
   */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight !== null) {
      await this.#inFlight;
      return;
    }
    this.#inFlight = this.#runOne().finally(() => {
      this.#inFlight = null;
    });
    await this.#inFlight;
  }

  #scheduleNext(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#tickFromTimer();
    }, delayMs);
  }

  async #tickFromTimer(): Promise<void> {
    if (this.#stopped) return;
    if (this.#inFlight !== null) {
      this.#scheduleNext(this.#tickMs);
      return;
    }
    this.#inFlight = this.#runOne().finally(() => {
      this.#inFlight = null;
      this.#scheduleNext(this.#tickMs);
    });
    await this.#inFlight;
  }

  async #runOne(): Promise<void> {
    let claimed: ClaimedRow | null;
    try {
      claimed = await this.#claim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log.error({ event: 'outbox_claim_failed', err: msg }, 'pending_jobs claim threw; will retry next tick');
      return;
    }
    if (claimed === null) return;

    // Defense-in-depth (Module 04a OQ7): the SQL claim already filters
    // by queue when #queueFilterSet is non-null; a row that slips
    // through is a programming bug or schema drift. Mark dead loudly
    // so the row doesn't loop forever and the operator sees the
    // mismatch in the doctor dead-letter check (M03.1 check 23).
    if (this.#queueFilterSet !== null && !this.#queueFilterSet.has(claimed.queue)) {
      const expected = this.#queueFilter?.join(',') ?? '<none>';
      const errMsg = `wrong_queue_for_worker_filter: claimed queue='${claimed.queue}' not in filter [${expected}]`;
      this.#log.error(
        { event: 'outbox_wrong_queue_assertion', jobId: claimed.id, queue: claimed.queue, expected },
        errMsg,
      );
      try {
        await this.#markDead(claimed.id, errMsg);
      } catch (deadErr) {
        const deadMsg = deadErr instanceof Error ? deadErr.message : String(deadErr);
        this.#log.error(
          { event: 'outbox_mark_dead_failed', jobId: claimed.id, err: deadMsg },
          'mark-dead threw after wrong-queue assertion',
        );
      }
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(claimed.payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log.error(
        { event: 'outbox_payload_invalid_json', jobId: claimed.id, err: msg },
        'pending_jobs row payload is not valid JSON; marking dead',
      );
      try {
        await this.#markDead(claimed.id, `payload not valid JSON: ${msg}`);
      } catch (deadErr) {
        const deadMsg = deadErr instanceof Error ? deadErr.message : String(deadErr);
        this.#log.error({ event: 'outbox_mark_dead_failed', jobId: claimed.id, err: deadMsg }, 'mark-dead threw');
      }
      return;
    }

    const job: OutboxJob = {
      id: claimed.id,
      queue: claimed.queue,
      payload,
      attempts: claimed.attempts,
    };

    let outcome: OutboxDispatchOutcome;
    try {
      outcome = await this.#dispatchHandler(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcome = { status: 'transient_failure', error: msg };
    }

    try {
      if (outcome.status === 'success') {
        await this.#deleteJob(job.id);
        this.#log.debug({ event: 'outbox_dispatch_success', jobId: job.id, queue: job.queue }, 'job dispatched');
        return;
      }
      if (outcome.status === 'permanent_failure' || shouldGiveUp(job.attempts, this.#maxAttempts)) {
        await this.#markDead(job.id, outcome.error);
        this.#log.warn(
          {
            event: 'outbox_dispatch_dead',
            jobId: job.id,
            queue: job.queue,
            attempts: job.attempts,
            err: outcome.error,
            permanent: outcome.status === 'permanent_failure',
          },
          'job marked dead',
        );
        return;
      }
      const backoffMs = computeBackoff(job.attempts);
      await this.#scheduleRetry(job.id, backoffMs, outcome.error);
      this.#log.warn(
        {
          event: 'outbox_dispatch_retry',
          jobId: job.id,
          queue: job.queue,
          attempts: job.attempts,
          backoffMs,
          err: outcome.error,
        },
        'job scheduled for retry',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#log.error(
        { event: 'outbox_post_dispatch_update_failed', jobId: job.id, err: msg },
        'failed to update pending_jobs row after dispatch outcome',
      );
    }
  }

  async #claim(): Promise<ClaimedRow | null> {
    const now = this.#clock();
    const queueFilter = this.#queueFilter;
    if (this.#db.kind === 'sqlite') {
      const nowSec = Math.floor(now / 1000);
      const leaseExpirySec = Math.floor((now - this.#leaseMs) / 1000);
      // SQLite serializes writes at the journal level; the atomic
      // UPDATE-with-LIMIT-1 statement guarantees only one of N
      // concurrent workers wins a given row.
      const queueClause = queueFilter !== null ? `AND queue IN (${queueFilter.map(() => '?').join(',')})` : '';
      const stmt = this.#db.raw.prepare(
        `UPDATE pending_jobs
           SET status='picked', picked_at=?, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM pending_jobs
           WHERE ((status='pending' AND run_after <= ?)
              OR (status='picked' AND picked_at IS NOT NULL AND picked_at < ?))
              ${queueClause}
           ORDER BY run_after ASC
           LIMIT 1
         )
         RETURNING id, queue, payload, attempts`,
      );
      const rows = stmt.all(nowSec, nowSec, leaseExpirySec, ...(queueFilter ?? [])) as ClaimedRow[];
      return rows[0] ?? null;
    }
    // postgres
    const nowDate = new Date(now);
    const leaseDeadline = new Date(now - this.#leaseMs);
    if (queueFilter !== null) {
      const rows = await this.#db.raw<ClaimedRow[]>`
        UPDATE pending_jobs
           SET status='picked', picked_at=${nowDate}, attempts = attempts + 1
         WHERE id = (
           SELECT id FROM pending_jobs
           WHERE ((status='pending' AND run_after <= ${nowDate})
              OR (status='picked' AND picked_at IS NOT NULL AND picked_at < ${leaseDeadline}))
              AND queue = ANY(${queueFilter as unknown as string[]})
           ORDER BY run_after ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, queue, payload, attempts
      `;
      return rows[0] ?? null;
    }
    const rows = await this.#db.raw<ClaimedRow[]>`
      UPDATE pending_jobs
         SET status='picked', picked_at=${nowDate}, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM pending_jobs
         WHERE (status='pending' AND run_after <= ${nowDate})
            OR (status='picked' AND picked_at IS NOT NULL AND picked_at < ${leaseDeadline})
         ORDER BY run_after ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, queue, payload, attempts
    `;
    return rows[0] ?? null;
  }

  async #deleteJob(id: string): Promise<void> {
    if (this.#db.kind === 'sqlite') {
      this.#db.raw.prepare('DELETE FROM pending_jobs WHERE id = ?').run(id);
      return;
    }
    await this.#db.raw`DELETE FROM pending_jobs WHERE id = ${id}`;
  }

  async #markDead(id: string, error: string): Promise<void> {
    const now = this.#clock();
    if (this.#db.kind === 'sqlite') {
      const nowSec = Math.floor(now / 1000);
      this.#db.raw
        .prepare(`UPDATE pending_jobs SET status='dead', failed_at=?, last_error=? WHERE id=?`)
        .run(nowSec, error, id);
      return;
    }
    const nowDate = new Date(now);
    await this.#db.raw`UPDATE pending_jobs SET status='dead', failed_at=${nowDate}, last_error=${error} WHERE id=${id}`;
  }

  async #scheduleRetry(id: string, backoffMs: number, error: string): Promise<void> {
    const runAfterMs = this.#clock() + backoffMs;
    if (this.#db.kind === 'sqlite') {
      const runAfterSec = Math.floor(runAfterMs / 1000);
      this.#db.raw
        .prepare(`UPDATE pending_jobs SET status='pending', run_after=?, last_error=? WHERE id=?`)
        .run(runAfterSec, error, id);
      return;
    }
    const runAfterDate = new Date(runAfterMs);
    await this.#db
      .raw`UPDATE pending_jobs SET status='pending', run_after=${runAfterDate}, last_error=${error} WHERE id=${id}`;
  }
}
