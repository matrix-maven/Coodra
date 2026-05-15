/**
 * Module 03.1 — public types for the durable audit outbox worker.
 *
 * The worker is in `@coodra/cli` (this package) because both the
 * `apps/hooks-bridge` and `apps/mcp-server` daemons import it: code
 * shared between two apps lives in a `packages/*` package, and the
 * CLI package already houses daemon abstractions, so adding a new
 * package here would just be a third-team-mode-style indirection
 * with no benefit.
 *
 * The worker pulls a single row from `pending_jobs` per tick (atomic
 * UPDATE-with-LIMIT-1 — SQLite serializes writes at the file lock,
 * Postgres uses FOR UPDATE SKIP LOCKED), invokes the consumer's
 * `OutboxDispatchHandler` to apply the row to its destination table,
 * then on success deletes the row, on transient failure schedules a
 * retry with backoff, on permanent failure (or after maxAttempts)
 * marks the row dead.
 */

export interface OutboxJob {
  /** `pending_jobs.id` — durable across worker restarts. */
  readonly id: string;
  /** `pending_jobs.queue` — routes to the right destination handler. */
  readonly queue: string;
  /**
   * `pending_jobs.payload`, JSON-parsed. The dispatch handler is
   * responsible for narrowing this to the queue-specific shape it
   * expects (Zod or a hand-rolled type guard).
   */
  readonly payload: unknown;
  /**
   * Attempt counter (1-indexed) AFTER the worker bumps it on claim.
   * On the first call this is `1`; on the fifth retry, `5`. The
   * worker uses this with `computeBackoff` to schedule retries.
   */
  readonly attempts: number;
}

/**
 * The dispatch outcome.
 *
 * - `success` — destination INSERT landed (or was a duplicate-key
 *   no-op handled idempotently by the destination INSERT). Worker
 *   deletes the `pending_jobs` row.
 * - `transient_failure` — the destination is temporarily unavailable
 *   (DB busy, FK target not yet seeded, network hiccup). Worker
 *   schedules a retry with backoff. After `maxAttempts` cumulative
 *   transient failures, the row is marked dead.
 * - `permanent_failure` — the row is malformed or the destination
 *   has rejected it for a reason that won't change with retries
 *   (schema violation, payload missing required field). Worker
 *   marks dead immediately.
 */
export type OutboxDispatchOutcome =
  | { readonly status: 'success' }
  | { readonly status: 'transient_failure'; readonly error: string }
  | { readonly status: 'permanent_failure'; readonly error: string };

/**
 * The consumer's dispatch contract. Bridge and mcp-server each
 * provide one (S2). Throwing from the handler is treated as a
 * transient failure (the message becomes `last_error`); prefer
 * returning an explicit outcome so behavior is testable without
 * relying on exception flow.
 */
export type OutboxDispatchHandler = (job: OutboxJob) => Promise<OutboxDispatchOutcome>;

/**
 * `pending_jobs.queue` values minted by Module 03.1 + Module 04a. Listed
 * here so a typo at any callsite is a compile-time error. New queues
 * land with the slice that introduces them — keep this list in sync.
 *
 * Module 04a S2 added `'sync_to_cloud'`. Bridge + mcp-server workers
 * filter to the four audit queues; the sync-daemon worker (S3) filters
 * to `'sync_to_cloud'`. Cross-pollination is prevented by `queueFilter`
 * on each worker plus a runtime assertion in `OutboxWorker.#runOne`.
 */
export type OutboxQueueKind = 'run_event' | 'session_open' | 'session_close' | 'policy_decision' | 'sync_to_cloud';

/**
 * The four audit-write queue kinds. Bridge + mcp-server `OutboxWorker`
 * instances pass this constant as their `queueFilter` so a stray
 * `sync_to_cloud` row is never claimed by them.
 */
export const AUDIT_QUEUE_KINDS = [
  'run_event',
  'session_open',
  'session_close',
  'policy_decision',
] as const satisfies ReadonlyArray<OutboxQueueKind>;

/**
 * Module 04a — paired sync-to-cloud job. Enqueued alongside each audit
 * write at the M03.1 callsites when `COODRA_MODE=team`. The
 * sync-daemon's dispatcher (Module 04a S3) reads the row from local
 * SQLite by the lookup key and pushes it to cloud Postgres.
 *
 * Why the sync payload carries only the lookup key and not the full
 * row contents: a row mutation between enqueue and dispatch is
 * harmless when the daemon re-reads the canonical state. (In practice
 * audit rows are append-only, so no mutation occurs — the lookup is
 * just the natural identifier.)
 */
export type SyncLookup =
  | { readonly kind: 'id'; readonly value: string }
  | { readonly kind: 'idempotency_key'; readonly value: string }
  | { readonly kind: 'project_session'; readonly projectId: string; readonly sessionId: string };

export type SyncTableName = 'runs' | 'run_events' | 'policy_decisions' | 'decisions' | 'context_packs';

export interface SyncToCloudPayloadV1 {
  readonly v: 1;
  readonly table: SyncTableName;
  readonly lookup: SyncLookup;
}
