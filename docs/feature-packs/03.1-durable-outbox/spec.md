# Module 03.1 — Durable Audit Outbox — Spec

> **Status:** scheduled (kicked off 2026-04-27, post-M08a). Replaces the placeholder spec from commit `acca01c`.
> **Depends on:** Module 03 (Hooks Bridge, merged in `93736f6`), Module 02 (MCP Server, merged in `770fe3d`).
> **Blocks:** Module 04 (Web App). The audit-trail UI assumes `policy_decisions` and `run_events` are durable across crashes; landing M04 first would lock in a contract this module is meant to fix.
> **Source of truth:** `system-architecture.md` §3.4 (CAP per service — outbox is AP), §4.3 (idempotency keys), §5 (Run Event Recording → Eventual Consistency), §7 (fail-open invariants), §16 pattern 3 (Outbox), ADR-006 (BullMQ for cloud queues — when applicable).

## 1. The problem

Today, every audit row written by the bridge — `run_events` (PostToolUse, UserPromptSubmit), `policy_decisions` (PreToolUse), and `runs` lifecycle UPDATEs — is dispatched via `setImmediate(...)` after the HTTP response returns. The dispatch is in-process and not durable:

- **SIGTERM mid-PreToolUse:** the policy decision returns to the agent (200 OK), the agent proceeds, but the bridge's audit-row INSERT is still queued in the event loop. If the process exits before the INSERT fires (kill -9, OOM, panic, deploy restart, laptop sleep cut short), the row is **lost forever**. The architecture's append-only invariant assumes the row landed; SOC2 / NHI governance reads silently miss the decision.
- **Same class of issue** for PostToolUse and UserPromptSubmit (`run_events`), and for SessionStart / Stop (`runs` open/close).
- **MCP `check_policy` has the same shape** — the audit write fires via `setImmediate(...)` in `apps/mcp-server/src/tools/check-policy/handler.ts:166`. Same race; same loss profile.
- **MCP `RunRecorder.record()` has the same shape** — `apps/mcp-server/src/lib/run-recorder.ts:121` is the second MCP-side callsite.

This was tolerable through M01–M03 because:

- Policy decisions are advisory; the agent already saw the answer.
- Idempotency keys (post-F14: `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}`) protect against duplicates on retry — the agent re-firing the same `tool_use_id` reproduces the same key, so a missed write can be replayed safely.
- M03's known-issues entry flagged this as "schedule a slice if visibility appears."
- M08a's doctor check 13 reports it as **permanent yellow** until M03.1 lands.

It is **not** tolerable past M04 because:

- Module 04's audit-trail UI is the first read surface that exposes "every decision in this run." Missing rows show up as gaps in the timeline.
- SOC2 readiness — the system-architecture.md §22+ governance positioning — assumes the audit log is **complete**, not best-effort.
- F8's runs↔run_events linkage and F14's idempotency-key shape are wasted if the writes themselves are still racy.

## 2. Goal

Replace `setImmediate(...)` audit dispatches with **durable enqueues to `pending_jobs`**, drained by an in-process worker per service. The contract:

- The HTTP handler's response still returns before the destination row is INSERTed (the agent doesn't wait for audit I/O).
- But the response returns **only after** the `pending_jobs` row is committed — the durability boundary moves from "in event-loop memory" to "in the WAL'd SQLite (or transactionally-committed Postgres) table."
- After **any** process exit (SIGTERM, SIGINT, kill -9, OOM, panic), restarting the service drains the queued rows; the destination row lands within seconds of restart.
- Idempotency at the destination (`policy_decisions.idempotency_key UNIQUE`, `run_events.id` PK, `runs (project_id, session_id)` UNIQUE) handles double-write under recovery.

The single load-bearing acceptance criterion: **a SIGTERM mid-PreToolUse with a queued audit write must result in the row landing after restart, not being lost.** Every test, every commit, every review answers to that AC.

## 3. Scope

### 3.1 In scope

1. **Schema migration 0004** — add `picked_at`, `failed_at`, `last_error` columns to `pending_jobs` (sqlite + postgres dialects, `@preserve`-block-locked migration parity per M01 discipline). Existing columns (`id`, `queue`, `payload`, `attempts`, `status`, `run_after`, `created_at`) stay as-is.
2. **`scheduleDurableWrite(handle, job)` helper** in `@coodra/db` — synchronous (from caller's POV) INSERT into `pending_jobs`. Wraps the canonical envelope: `{ id, queue, payload (JSON-serialized), attempts: 0, status: 'pending', run_after: now }`.
3. **`OutboxWorker` class** in `packages/cli/src/lib/outbox/` (one helper, two consumers). Owns the drain loop:
   - **Pickup:** `UPDATE pending_jobs SET status='picked', picked_at=now() WHERE status='pending' AND run_after <= now() RETURNING *` (single-row pickup; SQLite + postgres support RETURNING).
   - **Lease recovery:** rows with `status='picked' AND picked_at < now() - lease_timeout` are re-eligible (treated as orphans — the picking worker died).
   - **Dispatch:** the worker maps `queue` ∈ `{policy_decision, run_event, session_open, session_close}` to a destination-INSERT function. ON CONFLICT DO NOTHING at the destination.
   - **Success:** DELETE the `pending_jobs` row.
   - **Failure:** increment `attempts`, set `last_error`, schedule next retry via backoff. After max attempts: `status='dead'`, `failed_at=now()`. Stop retrying.
   - **Cadence:** hybrid — kick the loop on every `scheduleDurableWrite()` call (immediate attempt) AND a 1s tick for retries / orphan-recovery.
4. **Replace the 7 audit-write `setImmediate` callsites** with `scheduleDurableWrite`:
   - `apps/hooks-bridge/src/lib/run-recorder.ts` — 4 callsites: `recordPostToolUse` / `recordUserPromptSubmit` (via `scheduleRunEventInsert`), `recordSessionStart`, `recordSessionEnd`, `recordPolicyDecision`.
   - `apps/mcp-server/src/tools/check-policy/handler.ts` — 1 callsite (the `setImmediate(...)` at line 166).
   - `apps/mcp-server/src/lib/run-recorder.ts` — 1 callsite (the `setImmediate(...)` at line 121).
   - `apps/mcp-server/src/index.ts:187` — the "drain in-flight setImmediate audits" shim is **deleted** (obsolete; the durable outbox replaces it).
5. **Worker lifecycle.** Each service (`apps/hooks-bridge`, `apps/mcp-server`) starts an `OutboxWorker` at boot, stops it at SIGTERM. On stop: drain in-flight (await the current dispatch promise), then close the DB handle. SIGINT same path.
6. **Doctor checks** (3 new, as part of S+1 doctor extension):
   - **Check 21** — `pending_jobs queue depth` — count `WHERE status='pending'`. GREEN if ≤ 100, YELLOW if > 100, RED if > 1000 (running away).
   - **Check 22** — `pending_jobs oldest unprocessed` — `min(created_at) WHERE status='pending'`. GREEN if < 30s old, YELLOW if < 5min, RED if older (worker stuck or dead).
   - **Check 23** — `pending_jobs dead-letter count` — `count WHERE status='dead'`. GREEN if 0, YELLOW if > 0 with remediation pointing at `pending_jobs WHERE failed_at IS NOT NULL`.
7. **Crash-safety harness** — `__tests__/manual/verify-outbox-crash-safety.ts`:
   - Boot bridge against a tmp DB with a known `LOCAL_HOOK_SECRET`.
   - Fire one PreToolUse (queued audit write).
   - Send SIGTERM mid-flight (graceful path) AND `kill -9` mid-flight (hard path), each in separate runs.
   - Restart bridge, wait 2s for drain.
   - Assert `policy_decisions` row landed for the test toolUseId, idempotency_key has the F14 4-segment shape, runId joins back to the SessionStart-created `runs` row.
   - Land alongside `verify-phase5-closed-loop.ts` and `verify-f5-live.ts` as durable scaffolding so future modules can't regress this.

### 3.2 Out of scope (defer to Sync Daemon or later modules)

- **Cross-machine durable queue (BullMQ)** — both services share the same SQLite (solo) or Postgres (team) at this stage; an in-process worker per service is sufficient. When a future Sync Daemon adds cross-process / cross-machine fan-out, the queue layer can promote to BullMQ behind the same `scheduleDurableWrite` interface.
- **Backfill of historical NULL `run_id` rows** — out of scope per M03 verification §11.
- **Dead-letter queue UI** — surfaced via doctor (check 23). A web UI for failed jobs lands with M04's audit-trail surface, not here.
- **Per-org rate limiting on enqueue** — solo + early team mode don't need it; if team-mode audit volume warrants it, add in a follow-up slice (the worker can grow a per-org token bucket without changing the call surface).

## 4. Acceptance criteria

1. **The big AC.** SIGTERM mid-PreToolUse → restart → `policy_decisions` row lands with the correct F14 4-segment idempotency key and a non-NULL F8 runId. `verify-outbox-crash-safety.ts` is the test that proves it.
2. **Hard-crash AC.** `kill -9` mid-Pre → restart → same. Idempotency key still matches; no duplicate row.
3. **Graceful drain AC.** SIGTERM after PostToolUse (no in-flight Pre) → bridge drains queued `run_events` rows before exiting. Pre-stop count of `run_events` matches post-stop count + the queued rows (no loss).
4. **Restart drain AC.** Boot bridge against a DB that has `pending_jobs` rows from a prior crashed run → worker picks them up and lands the destination rows within 5 seconds of bridge boot.
5. **Idempotency AC.** Replaying a `pending_jobs` row whose destination row already exists is a no-op (ON CONFLICT DO NOTHING; queue row is then deleted).
6. **Worker-conflict AC.** Both bridge and mcp-server running against the same DB, both draining `pending_jobs` — no row is dispatched twice. Lease pickup serializes the claim.
7. **All 7 audit-write callsites** route through `scheduleDurableWrite`. The four old `setImmediate(...)` lines in `run-recorder.ts` (bridge + mcp-server), the one in `check-policy/handler.ts`, are gone. The drain shim in `apps/mcp-server/src/index.ts` is deleted.
8. **Existing harnesses still pass** — `verify-phase5-closed-loop.ts`, `verify-f5-live.ts`, and `verify-sigterm-drain.ts`. The whole-product loop survives the refactor.
9. **Doctor surfaces queue health** — checks 21, 22, 23 added with severity-tagged output and remediation strings.
10. **No new external deps.** `pending_jobs` is in the existing schema; the worker is plain TS + better-sqlite3 + drizzle. No Redis, no BullMQ.

## 5. Queue lifecycle (durable contract)

```
caller                          pending_jobs                        destination
------                          ------------                        -----------
scheduleDurableWrite(job)
  ┌──────────────────────────┐
  │ INSERT { id, queue,      │
  │   payload, status:       │
  │   'pending', run_after:  │
  │   now }                  │
  └──────────────────────────┘
                                row durable in WAL
caller returns to handler
handler returns 200 to agent
                                                                    ────────
                                                                    (crash, restart, or just tick)
                                                                    ────────
worker.tick()
                                UPDATE … SET status='picked',
                                picked_at=now()
                                WHERE status='pending'
                                  AND run_after <= now()
                                ORDER BY run_after ASC
                                LIMIT 1 RETURNING *
worker.dispatch(row)
                                                                    INSERT INTO policy_decisions
                                                                    … ON CONFLICT
                                                                    (idempotency_key)
                                                                    DO NOTHING
   on success
                                DELETE FROM pending_jobs
                                WHERE id = row.id
   on transient failure
                                UPDATE … SET attempts=attempts+1,
                                  last_error=err.message,
                                  status='pending',
                                  run_after=now() + backoff(attempts)
                                WHERE id = row.id
   on max-attempts reached
                                UPDATE … SET status='dead',
                                  failed_at=now()
                                WHERE id = row.id
```

**Crash recovery.** A row in `status='picked'` with `picked_at < now() - lease_timeout` is treated as orphaned (the worker that claimed it died). The next worker tick re-picks it. ON CONFLICT DO NOTHING at the destination catches the rare case where the original worker landed the destination row but died before deleting the queue row — the second pickup is a no-op INSERT, then DELETE proceeds.

## 6. Drain ownership

Each service (bridge and mcp-server) runs its own `OutboxWorker` instance against the same `pending_jobs` table:

- **Bridge** drains rows enqueued by hook handlers (PostToolUse, PreToolUse, SessionStart, SessionEnd, UserPromptSubmit).
- **MCP server** drains rows enqueued by `check_policy` (its own audit) and by `RunRecorder.record()`.

Workers compete for rows via the lease mechanism. SQLite WAL serializes writes anyway (one writer at a time); the lease pickup is the explicit serialization for postgres. Idempotency at the destination handles the rare double-pickup case.

**Why not single-worker (only bridge or only MCP):** if only the bridge drains, MCP-originated audits (from `check_policy` calls hitting the MCP server directly via stdio or HTTP) become bridge-availability-coupled. If only MCP drains, same in reverse. Independent workers per service mean each service's audit trail is durable as long as that service or any peer service is running.

## 7. Failure policy

**Retry schedule (exponential backoff with jitter):**

| Attempt | Backoff   | Reason                                                |
|---------|-----------|-------------------------------------------------------|
| 1       | 1 s       | Catches transient lock contention without thrashing.  |
| 2       | 5 s       | Catches a brief DB hiccup.                            |
| 3       | 30 s      | Catches a short outage.                               |
| 4       | 5 min     | Catches a longer auto-recoverable outage.             |
| 5       | 30 min    | Catches edge cases (cloud DB failover, network blip). |
| 6+      | (give up) | After ~35 min recovery window, declare the row dead.  |

**Give-up state.** `status='dead'`, `failed_at=now()`, `last_error` retained for forensic review. The row stays in `pending_jobs` (no separate `failed_jobs` table — single source of truth for queue state). Doctor check 23 surfaces the count.

**Doctor severity for dead-letter rows:** YELLOW with remediation. RED would block fresh-install scripts that run `coodra doctor && coodra start` after a transient DB error during a previous run. The agent has already proceeded based on the (advisory) policy decision; a forensic gap is uncomfortable but not blocking.

## 8. Lease timeout

**30 seconds.**

Rationale:
- Bridge's PreToolUse handler has a sub-200ms p95 budget (system-architecture.md §6); audit dispatch is sub-10ms typical.
- 30s comfortably exceeds any legitimate work window without making post-crash recovery slow.
- Tied to the bridge's SIGTERM grace period (also 30s by convention) — graceful drain has the full window before lease re-pickup kicks in.
- Crash recovery: bridge boots, worker ticks immediately, sees orphaned `picked` rows older than 30s, re-picks them. Sub-second recovery in practice (the orphan check fires on every tick, not only after 30s).

## 9. Backwards compatibility for non-audit `setImmediate`

**Only the audit-write callsites are replaced.** Other `setImmediate(...)` uses in the codebase are tick-yielding (not durability), and are out of scope.

Specifically:
- **`apps/mcp-server/src/index.ts:187`** — the "drain in-flight setImmediate audits" shim. **Deleted** (obsolete after M03.1).
- **`record_decision` via MCP** — synchronous on the agent's turn (the agent IS waiting for the response). The decisions-table INSERT runs in the handler body, not via setImmediate. No durability gap; no change.
- **`save_context_pack`** — synchronous, returns the contextPackId. No change.

## 10. Open design questions — sign off before S1

Five questions. Each has a recommendation in §11; the user signs off (or amends) before any slice past S0 lands.

1. **Cloud-mode strategy** — same `pending_jobs` table on Postgres, OR BullMQ-on-Redis per ADR-006? See §11 OQ1.
2. **Drain ownership** — bridge in-process worker, OR lift to MCP server, OR both? See §11 OQ2.
3. **Failure policy specifics** — retry schedule, give-up severity, "give up" semantics? See §11 OQ3.
4. **Lease timeout** — 30s, 5min, or other? See §11 OQ4.
5. **Backwards compat for non-audit `setImmediate`** — replace only audit paths or audit all uses? See §11 OQ5.

## 11. Locked design decisions (signed off [PENDING])

> All five carry a **recommendation** + **rationale** + **alternative**. None of S1+ lands until the user signs off here. S0 (the migration + scaffold) is independent and can land before sign-off.

### OQ1 — Cloud-mode strategy

- **Recommendation:** **same `pending_jobs` table on Postgres**. Solo and team modes share the same drain logic; the substrate differs only in which `DbHandle` the worker reads/writes.
- **Why this answer:** team-mode audit volume is governance-scale (thousands of decisions/day per active dev), not embedding-ingest scale. Postgres handles it without a dedicated queue. Adding Redis as a hard team-mode dep forces every customer to provision Upstash — friction for self-hosted / BYO-cloud deployments and a new operational surface area. BullMQ adds Redis-Lua complexity for marginal gain in this use case (no rate limiting needed; no job flows; no priorities).
- **Alternative:** BullMQ-on-Redis when team-mode volume justifies it (rate limiting per org, dashboards, multi-process distribution). The `scheduleDurableWrite` abstraction hides the substrate, so promotion is a follow-up slice — no architectural lock-in.
- **What this constrains:** S0 migration adds the missing columns to the existing `pending_jobs` schema (sqlite + postgres dialects). No `bullmq` dep in `package.json`.

### OQ2 — Drain ownership

- **Recommendation:** **each service owns its own drain worker** (bridge + mcp-server, both pulling from the same `pending_jobs` table; lease serializes pickup).
- **Why this answer:** the bridge is the source of most audit events but not all of them — `check_policy` on the MCP server has its own audit write. If only the bridge drains, MCP-originated audits become bridge-availability-coupled. If only MCP drains, bridge audits couple the other way. Independent workers mean each service's audit trail is durable as long as ANY worker is running. The lease mechanism (`status='picked' AND picked_at >= now()-30s`) prevents double-dispatch; idempotency at the destination handles the rare overlap.
- **Alternative:** single worker — choose bridge (the dominant source) and accept that MCP-only deployments aren't supported. Trade-off: simpler concurrency model, but couples MCP audit durability to bridge uptime. Not chosen because solo-mode dev workflows can run mcp-server without the bridge (e.g., via `pnpm --filter @coodra/mcp-server dev` for tooling smoke-tests).
- **What this constrains:** `OutboxWorker` is a generic class with a `dispatch(queue, payload)` map; both services compose it with their own dispatch handlers (the bridge handler and mcp-server handler can dispatch the same `queue` types — they share the same destination insert functions from `@coodra/db`).

### OQ3 — Failure policy specifics

- **Recommendation:**
  - **Retry schedule:** 1s → 5s → 30s → 5min → 30min, max 6 attempts (~35 min total recovery window).
  - **Give-up severity in doctor:** YELLOW with remediation, NOT RED.
  - **"Give up" semantics:** mark `status='dead'`, `failed_at=now()`, retain `last_error`. Row stays in `pending_jobs` (no separate `failed_jobs` table). Doctor check 23 surfaces the count.
- **Why this answer:**
  - Retry curve covers transient (lock contention, brief hiccup, short outage) and longer auto-recoverable cases without thrashing. After 35 min, something is genuinely broken — re-trying every minute thereafter just churns log lines.
  - YELLOW (not RED) for dead-letter: the policy decision was advisory; the agent already proceeded. A forensic gap is uncomfortable but not blocking. RED would surface as "doctor failed" in scripted setups (`coodra doctor && coodra start`) after a transient error during a prior run, breaking install flows.
  - Single-table dead-letter: simpler schema, single source of truth for queue state, and `WHERE failed_at IS NOT NULL` is the dead-letter view that doctor + future M04 audit UI can read directly.
- **Alternative:** exponential capped at 5min permanently (no give-up) — keeps retrying forever. Trade-off: avoids forensic gaps, but unbounded queue growth on persistent failure (e.g., DB schema mismatch). Not chosen — the give-up signal is what tells the operator something needs attention.
- **What this constrains:** `OutboxWorker.computeBackoff(attempts)` returns the schedule above. Doctor checks 21/22/23 use these severity thresholds.

### OQ4 — Lease timeout

- **Recommendation:** **30 seconds**.
- **Why this answer:** comfortably exceeds any legitimate audit dispatch (sub-10ms typical), short enough that crash recovery starts within 30s of restart. Aligns with the bridge's SIGTERM grace period (also 30s) — graceful drain has the full window before re-pickup kicks in. In practice, recovery is sub-second because the worker tick (1s cadence) re-checks orphaned rows on every iteration, not only at the lease-expiry boundary.
- **Alternative:** 5 minutes — too slow for the M03.1 AC of "SIGTERM mid-Pre, restart, row lands shortly after." 30s + immediate-tick on restart = sub-second recovery in practice.
- **What this constrains:** `OUTBOX_LEASE_MS = 30_000` — exported constant from the worker module.

### OQ5 — Backwards compat for non-audit `setImmediate`

- **Recommendation:** **replace only the audit-write callsites.** Leave non-audit `setImmediate` uses (tick-yielding, not durability) alone.
- **Why this answer:** the 7 audit callsites I inventoried are the durability bug M03.1 exists to close. Other `setImmediate` uses (e.g., MCP-server-side scheduler interactions, race-free promise-resolution patterns) are not durability — replacing them adds risk for zero benefit.
  - `record_decision` is synchronous on the agent's turn (the agent IS waiting for the response, the row is INSERTed in the handler body). No durability gap.
  - `save_context_pack` is synchronous; the contextPackId is part of the response. No durability gap.
  - `apps/mcp-server/src/index.ts:187` "drain in-flight setImmediate audits" shim is **deleted** as part of M03.1 — obsolete.
- **Alternative:** audit ALL `setImmediate` uses defensively. Trade-off: low-risk audit, but every non-audit use is a manual judgement call that costs review time. Not chosen — the bug to close is well-scoped.
- **What this constrains:** S2 (replace callsites) updates only the 7 inventoried lines. S2's diff is bounded; non-audit uses are explicitly listed as untouched.

## 12. Slice plan summary (full plan in `implementation.md`)

| Slice | Title                                                                                  |
|-------|----------------------------------------------------------------------------------------|
| S0    | Schema migration 0004 + `scheduleDurableWrite` helper in `@coodra/db`               |
| S1    | `OutboxWorker` class — pickup, lease, dispatch, retry, give-up                         |
| S2    | Replace 7 audit-write `setImmediate` callsites with `scheduleDurableWrite`             |
| S3    | Worker lifecycle wiring in `apps/hooks-bridge/src/index.ts` + mcp-server `index.ts`    |
| S4    | Doctor checks 21, 22, 23                                                               |
| S5    | `verify-outbox-crash-safety.ts` harness — SIGTERM + kill -9 paths                      |
| S6    | M03.1 closeout context pack + `current-session.md` handoff                             |

Each slice = one commit, M02/M03/M08a cadence: test/fix/document inline, no separate verification report. Whole-monorepo `turbo run typecheck lint test:unit` green at every slice boundary.
