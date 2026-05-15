# Module 04a — Sync Daemon + Self-Host Packaging — Spec

> **Status:** scheduled (kicked off 2026-04-28, post-M03.1 squash + Round-4 closeout).
> **Depends on:** Module 03.1 (Durable Audit Outbox, merged in `313d6f0`), Module 03 (Hooks Bridge, `93736f6`), Module 02 (MCP Server, `770fe3d`).
> **Blocks:** Module 04b (Web App). The audit-trail UI reads from cloud Postgres in team mode; without a daemon pushing local rows up, the web app sees an empty history.
> **Source of truth:** `system-architecture.md` §1 (two-mode model — "local services always write to local SQLite"), §3.6 (cloud sync REST shape), §4.1/§4.2 (schema parity is the contract sync rides on), §5 (Eventual Consistency for run-event recording), §7 (fail-open invariants), §13 (infra), §16 pattern 3 (Outbox), ADR-008 ("Cloud PostgreSQL is the team-sync layer — optional for individual developer use").

## 1. The problem

After M03.1, every audit row written by `apps/hooks-bridge` and `apps/mcp-server` lands durably in the **local** SQLite at `~/.coodra/data.db`. ADR-008 promises cloud Postgres as the team-sync layer; today, no process pushes local rows to that cloud. In practice this means:

- A team running Coodra in team mode has audit data scattered across N developer laptops with no central read surface.
- M04b's Web App (the first cloud read consumer) cannot ship — it would render empty timelines because `runs`, `run_events`, `policy_decisions`, `decisions`, and `context_packs` only exist locally.
- Self-hosters have no installable artifact today. The repo builds and runs from source, but there is no Dockerfile per service, no Compose stack, no documented deploy path. ADR-008's "optional team-sync layer" is aspirational.

This module closes both gaps: the **Sync Daemon** (a third long-running process spawned by `coodra start` when mode=team) ships local→cloud rows, and the **self-host packaging** (Dockerfiles + Compose + a one-platform deploy guide) makes the team-mode stack installable on infrastructure that is not the original developer's laptop.

It also closes two side-task functest findings the user flagged as in-scope here:
- **Finding #4** — doctor's port-availability check warns on healthy non-default ports. Suppress the warn when `/healthz` answers.
- **Finding #9** — bridge-auto-created `runs` rows use a bare UUID; should use the canonical 4-segment runId shape (matches MCP-minted rows).

## 2. Goal

Build a third service, `apps/sync-daemon`, that owns local→cloud push for the audit-trail tables. Reuse the M03.1 `pending_jobs` substrate as the work queue: every audit-write enqueue ALSO enqueues a `sync_to_cloud` job (or the existing audit-write job is augmented with a sync side-effect — design choice tracked in OQ7). The daemon drains its own queue against a Postgres handle, with the same lease/retry/dead-letter semantics M03.1 already verified.

The single load-bearing acceptance criterion: **a write to local SQLite must appear in cloud Postgres within the sync window (5–30s, settled by OQ2), with idempotency holding under cloud unreachability + recovery.** Every test, every commit, every review answers to that AC.

The secondary AC: **the team-mode stack is installable on a fresh machine with one `docker compose up`** — no source checkout, no `pnpm install`, no Drizzle CLI invocation needed for the operator.

## 3. Scope

### 3.1 In scope

1. **`apps/sync-daemon`** — new long-running TypeScript process. Boots a SQLite handle (local source) and a Postgres handle (cloud destination). Runs an `OutboxWorker` (reused from `@coodra/cli/lib/outbox`) configured for the `sync_to_cloud` queue. Same lease/retry/dead-letter machinery as M03.1; same `pending_jobs` table; same doctor surfaces extended with sync-specific checks.

2. **Sync substrate.** Reuse `pending_jobs` with a new queue value `'sync_to_cloud'`. Each existing audit-write job dispatched in M03.1 gains a paired sync enqueue at the same point (see OQ7 — single-job-with-sync-side-effect vs paired-jobs is a design choice; spec assumes paired for now). The Sync Daemon's worker only claims rows where `queue='sync_to_cloud'`; the bridge/MCP workers continue to claim only their own audit-destination queues.

3. **What gets synced (v1, append-only, idempotent at destination):**
   - `runs` — UPSERT by `(project_id, session_id)` UNIQUE.
   - `run_events` — INSERT ON CONFLICT (id) DO NOTHING.
   - `policy_decisions` — INSERT ON CONFLICT (idempotency_key) DO NOTHING.
   - `decisions` — INSERT ON CONFLICT (idempotency_key) DO NOTHING.
   - `context_packs` — INSERT ON CONFLICT (id) DO NOTHING.

   **Not synced in this module** (cloud-managed; flow cloud→local in a future module): `projects`, `feature_packs`, `policies`, `policy_rules`. Local copies of these are seed/cache; the cloud is authoritative for team-managed config.

4. **Hybrid sync trigger.**
   - **Immediate** — every `scheduleDurableWrite` for an audit-destination ALSO enqueues a paired `sync_to_cloud` job. Worker.kick() fires the daemon's drain. Hot path matches M03.1's <1s observable latency.
   - **Catchup poll** — periodic SELECT for any `sync_to_cloud` rows that the immediate path missed (e.g. the daemon was down when the audit was enqueued; the audit landed locally, the paired sync job either failed or never fired). Cadence locked at OQ2.

5. **Cloud unreachability behaviour (offline-first).**
   - Audit writes continue to land in local SQLite (M03.1 path, untouched).
   - Sync queue accumulates pending rows.
   - Doctor escalates queue depth + age per OQ3 thresholds.
   - On reconnect, the worker drains the backlog at the M03.1 hybrid cadence.
   - The local read path (`query_run_history` and friends) reads from SQLite always — never blocks on cloud.

6. **`coodra cloud-migrate` command** — runs Drizzle migrations against `DATABASE_URL`. Idempotent. Used by self-hosters before first daemon boot. Lives in `packages/cli/src/commands/cloud-migrate.ts`.

7. **Self-host packaging.**
   - **`deploy/Dockerfile.mcp-server`**, **`deploy/Dockerfile.hooks-bridge`**, **`deploy/Dockerfile.sync-daemon`** — multi-stage; pnpm install + turbo build → slim runtime image. Each carries the per-service entry binary, `node_modules`, and a non-root user. No Drizzle CLI in the runtime image — migrations are run via the `cloud-migrate` command from a one-shot container.
   - **`deploy/compose.yaml`** — the canonical stack: postgres (pgvector/pgvector:pg16), mcp-server, hooks-bridge, sync-daemon. Healthchecks. Bind-mounted `~/.coodra` for SQLite parity.
   - **`docs/deploy/self-host.md`** — happy-path guide for Docker Compose (OQ5). Covers env layout, first-boot migration, healthcheck verification, smoke test against the included Compose stack.
   - **`deploy/.env.example`** — every env var the stack needs, with comments and sample values for solo-dev.

8. **Doctor checks** (4 new, extending the M03.1 21/22/23 trio):
   - **Check 24** — `cloud reachability` — `SELECT 1` against `DATABASE_URL`. GREEN if reachable, YELLOW after 5min unreachable, RED after 1h. Skipped when `COODRA_MODE !== 'team'`.
   - **Check 25** — `sync queue depth` — `count WHERE queue='sync_to_cloud' AND status='pending'`. Same OQ3 thresholds as check 21 (0–10 green, 11–100 yellow, >100 red).
   - **Check 26** — `sync lag` — `now() - max(created_at) FROM runs` minus `now() - max(created_at) FROM runs ON cloud`. GREEN if <30s lag, YELLOW <5min, RED older. Skipped when cloud is unreachable (gracefully — already covered by 24).
   - **Check 27** — `sync dead-letter count` — `count WHERE queue='sync_to_cloud' AND status='dead'`. Same OQ3 thresholds as check 23.
   - **Fix to existing check 17/18** (functest finding #4) — port-availability check no longer warns when `/healthz` answers on the same port; the daemon is healthy, the warning is wrong.

9. **RunId format unification (functest finding #9).**
   - Bridge's auto-create-run path (`runs` row inserted from a SessionStart hook when no `get_run_id` has fired yet) currently writes a bare UUID for `runs.id`. MCP-minted rows use a canonical 4-segment encoding (`run:{slug}:{sessionId}:{shortId}`).
   - This module changes the bridge auto-create to use the canonical encoding. Migration adds a backfill for existing bare-UUID rows in dev DBs (idempotent; matches the M03 F8 widening pattern).

10. **Crash-safety + sync-roundtrip harnesses.**
    - **`__tests__/integration/manual/verify-sync-roundtrip.ts`** (new) — boots bridge + sync-daemon against a Postgres handle from `DATABASE_URL`. Fires one PreToolUse. Polls cloud Postgres for the `policy_decisions` row. Asserts row appears within the sync window. Variant: kill cloud connectivity, fire 5 PreToolUse, restore connectivity, assert all 5 rows land in cloud.
    - The existing `verify-outbox-crash-safety.ts` is re-run unchanged — the M03.1 audit-write path must not regress.
    - The existing `verify-phase5-closed-loop.ts` and `verify-f5-live.ts` are re-run unchanged.

### 3.2 Out of scope (defer to later modules)

- **Bidirectional sync** (cloud→local for policies/feature_packs/projects). Locked one-way push for v1 per OQ1 recommendation. A future module wires the inverse direction once the read pattern is exercised by M04b.
- **BullMQ migration** — same out-of-scope rationale as M03.1 §3.2. `pending_jobs` carries the load.
- **Backfill of historical NULL run_id rows in production databases** — out of scope per M03 verification §11; remains so.
- **Dead-letter UI in the Web App** — surfaced via doctor (checks 23, 27); a web UI lands with M04b.
- **/metrics endpoint** — locked OQ6: doctor only for v1. Prometheus scrape can be added without changing the worker contract.
- **Marketing site / landing page** — explicitly out per `essentialsforclaude/08-implementation-order.md` §8.1 (no Module 08, only 08a). The deploy guide is operator-facing, not marketing.
- **BYO-cloud team deploy variants** (Render, Heroku, k8s manifests). One Compose path is shipped; others get a "should also work" mention.
- **Per-org rate limiting on enqueue** — same as M03.1; not currently a load concern.

## 4. Acceptance criteria

**Primary AC.** A write to local SQLite appears in cloud Postgres within the sync window (5–30s, settled by OQ2), with idempotency holding under cloud unreachability + recovery.

Concretely, `verify-sync-roundtrip.ts` must:
1. Boot bridge + sync-daemon against a fresh local SQLite + a fresh Postgres (cleanup helper from M02 §F3).
2. Fire 5 PreToolUse + 1 SessionStart + 1 Stop hooks within 10s.
3. Within sync_window seconds (configurable, default per OQ2), assert:
   - 5 `policy_decisions` rows on cloud, all with the F14 4-segment idempotency_key, all joining back to a `runs` row.
   - 1 `runs` row on cloud with `started_at` matching the SessionStart, `ended_at` matching the Stop, status='completed', and the canonical 4-segment runId (functest finding #9 closed).
   - The local SQLite has the same rows (no regression on M03.1's append-only invariant).
4. Disconnect cloud (stop the daemon's Postgres pool / drop network), fire 5 more hooks, verify all 5 land in local SQLite + 5 sync_to_cloud rows accumulate in pending_jobs. Reconnect, verify all 5 drain to cloud within sync_window.

**Secondary AC.** The team-mode stack is installable on a fresh machine with `docker compose -f deploy/compose.yaml up -d` — no source checkout, no pnpm install, no manual migration command, no missing env vars. `docs/deploy/self-host.md` walks one operator through it in <10 minutes.

**Tertiary ACs (closing functest findings #4 and #9).**
- Doctor on a healthy team-mode stack reports 0 RED, 0 YELLOW, 0 false WARN. Specifically: ports 3100 + 3101 in use by mcp-server + hooks-bridge → check 17/18 GREEN (not YELLOW with "port in use" copy).
- A bridge-auto-created `runs` row (SessionStart with no preceding `get_run_id`) has `runs.id` matching `^run:[a-z0-9-]+:[A-Za-z0-9_-]+:[A-Za-z0-9]{8}$`. MCP-minted rows already match. The two paths produce identical encoding.

## 5. Non-goals

- **Cloud→local sync.** Deferred (OQ1).
- **Conflict resolution.** v1 sync is append-only; cloud is destination, local is source. UNIQUE indexes catch double-writes; there are no conflicting updates to merge.
- **Multi-tenant cloud.** v1 assumes one cloud Postgres per team, set via `DATABASE_URL`. The schema already carries `org_id` for future multi-tenancy.
- **Encryption-at-rest beyond what Postgres + the host filesystem provide.** Out of scope; operator concern.
- **TLS termination, WAF, ingress.** Operator concern. The Compose stack assumes the operator front-ends the stack with their own reverse proxy in production.

## 6. Open questions (FOR USER SIGN-OFF — DO NOT IMPLEMENT WITHOUT)

This spec is paused on these seven decisions. Recommendations and reasoning below; user picks final shape, then implementation begins.

- **OQ1 — sync direction for v1.** Recommend **one-way push** (local→cloud) for runs/run_events/policy_decisions/decisions/context_packs. Cloud→local for policies/feature_packs/projects becomes a future module after M04b exercises the read pattern. *Why:* simplest; matches ADR-008 framing; no conflict resolution; web app reads cloud directly so no inverse needed for v1. *Alternative:* bidirectional now (rejected — doubles surface area for unproven need; conflict semantics for `projects.updatedAt` open a design rabbit hole better deferred).

- **OQ2 — catchup poll cadence.** Recommend **30s**. *Why:* matches M03.1's 30s lease (one number for operators to reason about); hybrid means immediate-enqueue path still drains <1s for the hot path; 30s catchup recovers from daemon-was-down without flooding. *Alternative:* 5s (rejected — burns connections for low yield since hot path already covers <1s); 60s (rejected — drags audit visibility past comfort window for ops dashboards).

- **OQ3 — cloud unreachability escalation.** Recommend doctor check 24: GREEN if reachable, YELLOW after 5min unreachable, RED after 1h. *Why:* mirrors OQ3 from M03.1 — same operator mental model; 5min absorbs transient blips without paging; 1h is unambiguous "cloud is down, page someone." *Alternative:* shorter windows (5s yellow, 5min red) — rejected as too noisy for transient blips.

- **OQ4 — cloud Postgres migration ownership.** Recommend a separate **`coodra cloud-migrate`** CLI command, run by the operator before first sync-daemon boot (and on every deploy that ships a new migration). *Why:* explicit > implicit; operators expect a migration step; auto-on-Web-App-boot couples ops to runtime and risks racing migrations across instances. *Alternative:* auto-on-Web-App-boot (rejected — race risk, unclear ownership when N web instances start in parallel); auto-on-sync-daemon-boot (rejected — same race risk; operator can't disable).

- **OQ5 — self-host deploy happy path.** Recommend **Docker Compose** for the canonical guide; brief mentions for Railway and Fly.io. *Why:* Compose is the universal substrate; any managed platform can be derived; operators who want managed get Compose-as-reference. *Alternative:* Railway-first (rejected — locks the guide to one vendor; less self-hosted in spirit); bare systemd (rejected — too much per-distro detail for a v1 guide).

- **OQ6 — sync metrics surface.** Recommend **doctor only** for v1. Doctor already surfaces queue health via checks 24–27; no new server boot path; no Prometheus dep added; ops can add /metrics later as a non-breaking change. *Alternative:* /metrics now (rejected — out of scope for "make it work"; the worker contract doesn't change so adding it later is a one-slice job).

- **OQ7 — queue substrate.** Recommend **reuse `pending_jobs` with a new `queue='sync_to_cloud'` value, paired-job pattern.** Each audit-write enqueue at the M03.1 callsites also enqueues a paired sync_to_cloud job referring to the same destination row by id. *Why:* simplest; M03.1 lease/retry/dead-letter applies for free; one substrate, one set of doctor checks (extended). *Alternative-A:* single-job-with-sync-side-effect (rejected — couples destination INSERT to cloud INSERT; failure of one blocks the other); *alternative-B:* separate `sync_jobs` table (rejected — duplicates schema; needs its own lease/retry/dead-letter machinery; worth it only if pending_jobs starves under load, which it currently does not).

## 7. Out of scope per user directive (re-affirmed)

- **No billing / Stripe / seat management.** Per `essentialsforclaude/08-implementation-order.md` §8.1.
- **No marketing site, no coodra.dev HTML, no landing page.** Same source.
- **No BYO-cloud Enterprise variant.** Team mode is operator-hosted; one canonical Compose path.

## 8. References

- Architecture: `system-architecture.md` §1, §3.6, §4.1/§4.2, §5, §7, §13, §16 pattern 3
- ADRs: `essentialsforclaude/11-adrs.md` ADR-008 (cloud Postgres as team-sync layer)
- Predecessor module: `docs/feature-packs/03.1-durable-outbox/spec.md` (the queue substrate this rides on)
- Predecessor closeout: `docs/context-packs/2026-04-28-module-03.1-durable-outbox.md`
- Round-4 functest pack: identifies finding #4 (port-availability false warn) and finding #9 (runId format split). The current closeout doc on `main` for those is `docs/context-packs/2026-04-27-run-proj_0d1738d.md` (or whichever the Round-4 closeout filename is).
