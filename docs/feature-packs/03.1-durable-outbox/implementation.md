# Module 03.1 — Durable Audit Outbox — Implementation Plan

> **Cadence.** Linear slices, one commit each, test/fix/document inline (M02/M03/M08a pattern). Whole-monorepo `turbo run typecheck lint test:unit` green at every slice boundary. No separate verification report.
>
> **Branch.** `feat/03.1-durable-outbox` off `main` (post-M08a, post-cleanup).
>
> **Open-question gate.** S0 is independent (schema + helper scaffold) and may land before sign-off. **S1 onward depends on the user's sign-off on the five OQs in `spec.md` §11.** The plan reflects the recommended answers; if the user amends, the affected slices update before the slice is started.

## Cross-cutting invariants

- **The big AC:** SIGTERM mid-PreToolUse → restart → `policy_decisions` row lands. `verify-outbox-crash-safety.ts` (S5) is the test that proves it.
- **No new external deps.** `pending_jobs` is in the schema since M01. Worker is plain TS + `better-sqlite3` + Drizzle.
- **Per-slice green gate.** Each commit passes `pnpm exec turbo run typecheck lint test:unit` across the monorepo.
- **Migration-lock discipline.** S0's migration 0004 has a `@preserve` block IF any hand-rolled SQL is needed; otherwise pure Drizzle-Kit emit. Verify with `pnpm --filter @coodra/db check:migration-lock`.
- **COODRA_HOME precedence.** The worker reads/writes via the same `DbHandle` the bridge + mcp-server use, so the M08a fix `37f70d0` (resolveSqlitePath honours COODRA_HOME) makes the worker write to the same DB doctor reads from automatically — no new path-resolution logic.

## Slice plan

### S0 — Schema migration 0004 + `scheduleDurableWrite` helper in `@coodra/db`

**Independent of OQ sign-off** — pure schema + helper, no behavioral change for callsites. Lands on `feat/03.1-durable-outbox` directly.

**Files:**
- `packages/db/drizzle/sqlite/0004_<adjective>_<noun>.sql` (Drizzle-Kit emitted) + `meta/_journal.json` update.
- `packages/db/drizzle/postgres/0004_<adjective>_<noun>.sql` + journal update.
- `packages/db/migrations.lock.json` — only updated if a `@preserve` block is added (likely not for this migration).
- `packages/db/src/schema/sqlite.ts` — add `pickedAt`, `failedAt`, `lastError` columns to `pendingJobs`.
- `packages/db/src/schema/postgres.ts` — same columns, dialect-parallel.
- `packages/db/src/schedule-durable-write.ts` (new) — `scheduleDurableWrite(handle, job)` — INSERT into `pending_jobs` with the canonical envelope. Exported from `@coodra/db`.
- `packages/db/src/index.ts` — re-export `scheduleDurableWrite` + the new types.

**Schema additions:**

```typescript
export const pendingJobs = sqliteTable(
  'pending_jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    payload: text('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    status: text('status').notNull().default('pending'), // 'pending' | 'picked' | 'dead'
    runAfter: integer('run_after', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    pickedAt: integer('picked_at', { mode: 'timestamp' }),     // NEW — set on UPDATE … status='picked'
    failedAt: integer('failed_at', { mode: 'timestamp' }),     // NEW — set on max-attempts exhaustion
    lastError: text('last_error'),                              // NEW — set on every failed attempt
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('pending_jobs_poll_idx').on(t.queue, t.status, t.runAfter),
    index('pending_jobs_picked_idx').on(t.status, t.pickedAt),  // NEW — fast orphan recovery
  ],
);
```

Postgres dialect mirrors with `timestamp({ withTimezone: true, mode: 'date' })`.

**Tests (new + updated):**
- `packages/db/__tests__/integration/schedule-durable-write.test.ts` (new) — 5 cases:
  1. Fresh DB, enqueue one job → row exists in `pending_jobs` with `status='pending'`, `attempts=0`, `payload` round-trips through JSON.
  2. Two enqueues with the same caller-supplied id → second is `ON CONFLICT (id) DO NOTHING` no-op (caller controls dedupe).
  3. `runAfter` defaults to now (unix-seconds boundary check).
  4. `payload` accepts arbitrary JSON-serializable values via the helper's serializer.
  5. New columns (`pickedAt`, `failedAt`, `lastError`) all default to NULL.
- `packages/db/__tests__/integration/postgres-migrate.test.ts` — add an assertion that the new columns + index exist after migration 0004 applies.

**Verification:**
- `pnpm --filter @coodra/db check:migration-lock` — clean.
- `pnpm --filter @coodra/db test:integration` — green; new test file passes.
- `pnpm --filter @coodra/db build && pnpm exec turbo run typecheck lint test:unit` — green across the monorepo.

**Commit message:** `feat(db): pending_jobs.{picked_at,failed_at,last_error} + scheduleDurableWrite helper for the durable audit outbox (S0)`

---

### S1 — `OutboxWorker` class

**Lands after OQ sign-off.** The class encapsulates the drain loop; consumers (bridge, mcp-server) compose it with their own dispatch handlers.

**Files:**
- `packages/cli/src/lib/outbox/types.ts` — `OutboxJob`, `OutboxQueueKind`, `OutboxDispatchHandler`, `OutboxDispatchResult`.
- `packages/cli/src/lib/outbox/worker.ts` — `OutboxWorker` class with `start()`, `stop()`, `tick()`, `dispatch(row)`. 1-second tick; immediate-attempt on enqueue (the worker exposes a `kick()` method that consumers call from `scheduleDurableWrite`'s caller).
- `packages/cli/src/lib/outbox/backoff.ts` — `computeBackoff(attempts)` returns the per-attempt delay (1s/5s/30s/5min/30min/give-up).
- `packages/cli/src/lib/outbox/index.ts` — barrel re-export.

**Wait — why does the OutboxWorker live in `packages/cli`?** Because bridge and mcp-server are both apps; sharing code between apps means the code lives in a `packages/*` package. `@coodra/cli` already houses the daemon abstraction; adding the worker there avoids a new package. Both apps import it. (If this feels like the wrong package, S1 may move it to `@coodra/shared` or a new `@coodra/outbox` — sign-off step before S1 starts.)

**Behavioral spec:**

```typescript
export class OutboxWorker {
  constructor(deps: { db: DbHandle; dispatchHandler: OutboxDispatchHandler; logger?: Logger; clock?: () => number; tickMs?: number; leaseMs?: number; maxAttempts?: number; });
  start(): void;                  // begins the 1s tick loop
  stop(): Promise<void>;           // stops accepting new ticks; awaits in-flight dispatch
  kick(): void;                    // schedules an immediate tick (called from scheduleDurableWrite path for low latency)
  // Internal:
  // tick(): claim one row → dispatch → on success delete, on transient failure schedule retry, on exhaustion mark dead
}
```

**Tests:**
- `packages/cli/__tests__/unit/outbox/worker.test.ts` (new) — 8 cases:
  1. `tick()` claims a `status='pending' AND run_after<=now` row → dispatchHandler called with the deserialized payload → on success, row deleted.
  2. `tick()` with no eligible rows → no-op, no error.
  3. `tick()` claims an orphaned `status='picked' AND picked_at < now-leaseMs` row → re-dispatched.
  4. `dispatchHandler` throws transient (e.g. `BUSY`) → row's `attempts` increments, `last_error` set, `run_after` advances by backoff.
  5. `dispatchHandler` throws max-attempts → row goes `status='dead'`, `failed_at` set, `last_error` retained.
  6. `kick()` triggers an immediate dispatch without waiting for the next tick.
  7. `stop()` waits for in-flight dispatch before returning.
  8. Concurrent workers (two `OutboxWorker` instances on the same DB): each row is dispatched exactly once (lease serialization).
- `packages/cli/__tests__/unit/outbox/backoff.test.ts` — 3 cases: schedule shape, give-up at attempts ≥ MAX_ATTEMPTS, monotonically increasing.

**Verification:** `pnpm exec turbo run typecheck lint test:unit --filter=@coodra/cli` ✓.

**Commit message:** `feat(cli): OutboxWorker — pickup/lease/dispatch/retry/give-up loop for the durable audit outbox (S1)`

---

### S2 — Replace 7 audit-write `setImmediate` callsites with `scheduleDurableWrite`

**Files (modify):**
- `apps/hooks-bridge/src/lib/run-recorder.ts`:
  - `scheduleRunEventInsert` → enqueue to `pending_jobs` with `queue='run_event'`. Drop the `schedule(async()=>...)` wrapper; payload includes `event`, `phase`, `projectId`, `logEvent`.
  - `recordSessionStart` → enqueue with `queue='session_open'`.
  - `recordSessionEnd` → enqueue with `queue='session_close'`.
  - `recordPolicyDecision` → enqueue with `queue='policy_decision'`. Move runId resolution (`lookupRunId`) into the worker's dispatch handler, not the caller (the runs row may not exist yet at enqueue time; resolving at dispatch makes the runId-NOT-NULL invariant easier to hold).
- `apps/mcp-server/src/lib/run-recorder.ts`:
  - `record()` → enqueue with `queue='run_event'`. Drops `setImmediate(...)` wrapper.
- `apps/mcp-server/src/tools/check-policy/handler.ts:166`:
  - Drops `setImmediate(...)`. Enqueue directly via `scheduleDurableWrite(deps.db, { queue: 'policy_decision', payload })`.
- `apps/mcp-server/src/index.ts:187`:
  - **Deletes** the `setImmediate(resolve)` "drain in-flight" shim. Replaced by the OutboxWorker's `stop()` (S3).

**Files (new):**
- `apps/hooks-bridge/src/lib/outbox-dispatch.ts` — `createBridgeDispatchHandler({ db, logger })` returning the `OutboxDispatchHandler` that maps `queue` → destination INSERT (uses `lookupRunId`, `recordPolicyDecision` from `@coodra/db`, the runs/run_events insert helpers from `run-recorder.ts`'s body refactored into pure functions).
- `apps/mcp-server/src/lib/outbox-dispatch.ts` — same shape; the dispatch table is shared (both services dispatch the same `queue` types) but each app has its own typed factory.

**Refactor opportunity:** the destination-insert bodies currently inline in `run-recorder.ts` move to `@coodra/db` as pure helpers (`insertRunEvent`, `insertRun`, `closeRun`, `recordPolicyDecision` — which already exists). The bridge's `run-recorder.ts` shrinks to just enqueue + the existing `clampToolInput`. The mcp-server's `run-recorder.ts` shrinks similarly.

**Tests:**
- `apps/hooks-bridge/__tests__/integration/run-recorder.test.ts` — update to assert that calling `recordPolicyDecision` LANDS A ROW IN `pending_jobs` (not directly in `policy_decisions`), and that running the worker drains it to `policy_decisions`.
- New: `apps/hooks-bridge/__tests__/integration/handlers/outbox-end-to-end.test.ts` — full lifecycle: PreToolUse → row enqueued → worker drains → `policy_decisions` row visible.
- `apps/mcp-server/__tests__/integration/tools/check-policy.test.ts` — same shape: assert the audit hits `pending_jobs` first, then drained.

**Verification:**
- All existing handlers tests still pass (the wrapper changes from `setImmediate` to `scheduleDurableWrite` is invisible at the recorder API).
- `pnpm exec turbo run typecheck lint test:unit` ✓.

**Commit message:** `feat(bridge,mcp-server,db): replace 7 setImmediate audit dispatches with scheduleDurableWrite (S2)`

---

### S3 — Worker lifecycle wiring

**Files (modify):**
- `apps/hooks-bridge/src/index.ts` — boot path: instantiate `OutboxWorker({ db: dbClient.handle, dispatchHandler: createBridgeDispatchHandler(...) })`, call `worker.start()` after the policy engine is wired. SIGTERM/SIGINT handler awaits `worker.stop()` before closing the DB.
- `apps/mcp-server/src/index.ts` — same pattern. Replaces the deleted `setImmediate(resolve)` drain shim from S2.

**Tests:**
- `apps/hooks-bridge/__tests__/integration/lifecycle/worker-start-stop.test.ts` (new) — boot bridge, enqueue a job pre-boot (simulate prior crash), start bridge, observe drain within 5s. SIGTERM: in-flight dispatch completes before exit.
- Same for mcp-server.

**Verification:**
- E2E `__tests__/e2e/full-session-with-hooks-bridge.test.ts` updated if needed (likely no change — the recorder API is unchanged).
- `pnpm test:e2e` ✓.

**Commit message:** `feat(bridge,mcp-server): wire OutboxWorker into service lifecycle (S3)`

---

### S4 — Doctor checks 21, 22, 23

**Files (new):**
- `packages/cli/src/doctor/checks/21-pending-jobs-depth.ts` — counts `WHERE status='pending'`.
- `packages/cli/src/doctor/checks/22-pending-jobs-oldest.ts` — `min(created_at) WHERE status='pending'`.
- `packages/cli/src/doctor/checks/23-pending-jobs-dead-letter.ts` — counts `WHERE status='dead'`.

**Files (modify):**
- `packages/cli/src/doctor/registry.ts` — register the three new checks.
- `packages/cli/src/doctor/checks/13-audit-durability.ts` — convert from "permanent yellow placeholder" to "GREEN (closed by Module 03.1)" while keeping the check id. Update remediation text.

**Tests:**
- `packages/cli/__tests__/unit/doctor/checks-fixture.test.ts` — add 3 new fixtures: queue depth thresholds, oldest age thresholds, dead-letter count thresholds. Each fixture seeds `pending_jobs` rows with controlled timestamps and asserts severity.

**Commit message:** `feat(cli): doctor checks 21–23 surface pending_jobs queue health; close M03.1 placeholder check 13 (S4)`

---

### S5 — `verify-outbox-crash-safety.ts` harness

**Files (new):**
- `__tests__/manual/verify-outbox-crash-safety.ts` — the load-bearing test for the big AC.

**Behavior:**
1. Boot bridge + mcp-server in-process (or fork as subprocesses) against a tmp DB.
2. Fire one PreToolUse → row enqueued. Verify `pending_jobs.status='pending'` exists.
3. **Path A (graceful):** SIGTERM the bridge. Wait. Restart. Wait 2s. Assert `policy_decisions` row landed.
4. **Path B (hard):** `kill -9` the bridge (separate subprocess run). Restart. Wait 2s. Assert same.
5. Both paths assert: idempotency_key has the F14 4-segment shape, runId joins back to the SessionStart-created `runs` row (F8 invariant), no orphan `pending_jobs` row left behind.

**Files (modify):**
- `__tests__/manual/README.md` — add the new harness to the durable-scaffolding list alongside `verify-phase5-closed-loop.ts` and `verify-f5-live.ts`.

**Verification:**
- Run the harness 3× in a row. All pass.
- Re-run `verify-phase5-closed-loop.ts` and `verify-f5-live.ts` against the post-S5 build to confirm no regression.

**Commit message:** `test(integration): verify-outbox-crash-safety.ts — SIGTERM + kill -9 mid-Pre, prove the audit row lands after restart (S5)`

---

### S6 — M03.1 closeout context pack

**Files (new):**
- `docs/context-packs/<YYYY-MM-DD>-module-03.1-durable-outbox.md` — full closeout following `docs/context-packs/template.md`. Records:
  - All 6 slice commits (S0–S5, hash + one-line title).
  - 5 OQ decisions locked at sign-off.
  - Files touched (grouped by package/app).
  - Test counts.
  - Verification commands.
  - Scope-boundary statement (what's deferred to M04 / Sync Daemon).
  - Handoff: squash-merge `feat/03.1-durable-outbox` to `main` → Module 04 (Web App).

**Files (modify):**
- `context_memory/current-session.md` — overwrite with the M03.1 session log; "Next action" = "Module 04 (Web App) kickoff per `docs/feature-packs/04-web-app/spec.md`".

**Re-call** `coodra__save_context_pack` with the full pack content.

**Commit message:** `docs(03.1-durable-outbox): closeout context pack + session-memory handoff (S6)`

---

## Post-merge verification

After all 6 slices land and the branch is squash-merged to main:

1. **Run the durable harness suite against post-merge `main`:**
   - `verify-outbox-crash-safety.ts` (new) — 3× consecutive runs, all pass.
   - `verify-phase5-closed-loop.ts` — pass (no regression).
   - `verify-f5-live.ts` — pass.
   - `verify-sigterm-drain.ts` — pass (the M03 graceful-drain test).
2. **Whole-repo gates:** `pnpm exec turbo run typecheck lint test:unit` ✓ across the monorepo.
3. **Doctor on a fresh tmp HOME** — checks 13 / 21 / 22 / 23 surface as expected; queue depth 0 on a quiescent install.

## Out of scope (carry forward)

- **BullMQ-on-Redis migration** — defer to a future slice if team-mode audit volume justifies it.
- **Backfill of historical NULL run_id rows** — out of scope per M03 verification §11.
- **Dead-letter UI** — surfaced via doctor (check 23). M04 audit-trail surface will read from `pending_jobs WHERE failed_at IS NOT NULL` for any UI component.
- **Per-org rate limiting on enqueue** — defer.

## References

- Spec — `docs/feature-packs/03.1-durable-outbox/spec.md`.
- Tech stack — `docs/feature-packs/03.1-durable-outbox/techstack.md`.
- Architecture — `system-architecture.md` §3.4 (CAP), §4.3 (idempotency), §16 pattern 3 (Outbox), ADR-006.
- The 7 audit callsites being replaced — see `spec.md` §3.1 item 4.
- M08a closeout (post-08a integration findings) — `docs/context-packs/2026-04-27-module-08a-cli.md` for the doctor-pattern + COODRA_HOME precedence cross-references.
